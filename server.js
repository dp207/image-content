const express = require('express');
const axios = require('axios');
const multer = require('multer');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({ dest: 'uploads/' }); // 临时存储上传的图片

// 配置百度AI参数
const BAIDU_API_KEY = '5AFiTvcTEU1bVseSII4CO8Q5';
const BAIDU_SECRET_KEY = '83z6Yck0Q3xrU7kVn7cTESdcuMQTxAE4';
// 配置通义千问参数
const DASHSCOPE_API_KEY = 'sk-807f2ec9a1a9416192812e5745820a62';

// 跨域支持
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// 1. 获取百度AI的access_token
async function getBaiduAccessToken() {
  const startTime = Date.now();
  const response = await axios.post(`https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${BAIDU_API_KEY}&client_secret=${BAIDU_SECRET_KEY}`);
  const endTime = Date.now();
  console.log(`获取百度 Access Token 耗时: ${endTime - startTime}ms`);
  return response.data.access_token;
}

// 2. 百度图像识别：提取图片标签
async function recognizeImage(imagePath) {
  const startTime = Date.now();
  const token = await getBaiduAccessToken();
  
  // 读取图片并转换为base64
  const bitmap = fs.readFileSync(imagePath);
  const base64Img = Buffer.from(bitmap).toString('base64');

  // 1. 提交图像内容理解请求
  const submitStartTime = Date.now();
  const submitResponse = await axios.post('https://aip.baidubce.com/rest/2.0/image-classify/v1/image-understanding/request', 
    {
      'image': base64Img,
      'question': '请描述图片内容并提取关键标签' // 图像内容理解接口需要一个问题
    }, 
    {
      headers: { 
        'Content-Type': 'application/json' 
      },
      params: { access_token: token }
    }
  );
  const submitEndTime = Date.now();
  console.log(`提交图像内容理解请求耗时: ${submitEndTime - submitStartTime}ms`);

  console.log('百度图像内容理解-提交请求返回数据:', JSON.stringify(submitResponse.data, null, 2));

  if (!submitResponse.data.result || !submitResponse.data.result.task_id) {
    throw new Error(`百度图像内容理解-提交请求失败: ${JSON.stringify(submitResponse.data)}`);
  }

  const taskId = submitResponse.data.result.task_id;
  let resultResponse;
  let maxAttempts = 10; // 最多轮询10次
  let attempts = 0;

  // 2. 轮询获取图像内容理解结果
  const getResultStartTime = Date.now();
  while (attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 2000)); // 等待2秒
    resultResponse = await axios.post('https://aip.baidubce.com/rest/2.0/image-classify/v1/image-understanding/get-result', 
      {
        'task_id': taskId
      }, 
      {
        headers: { 
          'Content-Type': 'application/json' 
        },
        params: { access_token: token }
      }
    );

    console.log(`百度图像内容理解-获取结果返回数据 (尝试 ${attempts + 1}/${maxAttempts}):`, JSON.stringify(resultResponse.data, null, 2));

    if (resultResponse.data.result && resultResponse.data.result.ret_code === 0) {
      break; // 任务完成
    }
    attempts++;
  }
  const getResultEndTime = Date.now();
  console.log(`轮询获取图像内容理解结果总耗时: ${getResultEndTime - getResultStartTime}ms`);

  if (!resultResponse || !resultResponse.data.result || resultResponse.data.result.ret_code !== 0) {
    throw new Error(`百度图像内容理解-获取结果超时或失败: ${JSON.stringify(resultResponse ? resultResponse.data : '无返回数据')}`);
  }

  // 提取标签
  console.log('原始 description 内容:', resultResponse.data.result.description);
  const labels = resultResponse.data.result.description;
  const recognizeImageEndTime = Date.now();
  console.log(`recognizeImage 函数总耗时: ${recognizeImageEndTime - startTime}ms`);
  return labels;
}

// 3. 通义千问生成表情包文案
async function generateCaption(imageLabels) {
  const startTime = Date.now();
  const prompt = `根据图片标签：${imageLabels}，生成5组幽默，每组文案包含顶部文字和底部文字，格式为JSON数组：[{"top":"顶部文案","bottom":"底部文案"}]`;
  
  const response = await axios.post('https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation', {
    model: 'qwen-plus', // 免费的轻量版模型
    input: { prompt: prompt },
    parameters: {
      result_format: 'json',
      temperature: 0.8, // 提高文案随机性
      top_p: 0.8
    }
  }, {
    headers: {
      'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  console.log('通义千问API返回数据:', JSON.stringify(response.data, null, 2));

  if (!response.data.output || !response.data.output.choices || !response.data.output.choices[0] || !response.data.output.choices[0].message || !response.data.output.choices[0].message.content) {
    throw new Error(`通义千问API调用失败或返回格式不正确: ${JSON.stringify(response.data)}`);
  }

  const endTime = Date.now();
  console.log(`通义千问 API 调用耗时: ${endTime - startTime}ms`);
  return JSON.parse(response.data.output.choices[0].message.content);
}

// 后端接口：上传图片并生成文案
app.post('/api/generate', upload.single('image'), async (req, res) => {
  try {
    // 1. 识别图片标签
    const labels = await recognizeImage(req.file.path);
    // 2. 生成文案
    const captions = await generateCaption(labels);
    // 3. 删除临时文件
    fs.unlinkSync(req.file.path);
    // 4. 返回结果
    res.json({ success: true, labels, captions });
  } catch (error) {
    console.error(error);
    res.json({ success: false, message: '生成失败' });
  }
});

// 启动后端服务
app.listen(3000, () => {
  console.log('后端服务运行在 http://localhost:3000');
});