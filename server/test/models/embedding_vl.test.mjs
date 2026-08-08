// test_vl_embedding_fixed.mjs
import http from 'http';
import fs from 'fs';
import path from 'path';

// const HOST = '222.18.149.200';
// const PORT = 1242;
// const MODEL_NAME = 'qwen-vl-embedding-2b';

// const HOST = '222.18.149.10';
// const PORT = 1238;
// const MODEL_NAME = 'qwen3-vl-embedding-8b';

const HOST = '127.0.0.1';
const PORT = 3000;
const PATH = '/v1/embeddings';
const MODEL_NAME = 'embedding-vl';


// ==================== 辅助函数 ====================

function imageToBase64(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`❌ 图片不存在: ${filePath}`);
    process.exit(1);
  }
  const data = fs.readFileSync(filePath);
  const ext = path.extname(filePath).slice(1).toLowerCase() || 'jpeg';
  const mimeMap = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', gif: 'gif', webp: 'webp' };
  return `data:image/${mimeMap[ext] || 'jpeg'};base64,${data.toString('base64')}`;
}

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function sendRequest(postData) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: HOST,
      port: PORT,
      path: '/v1/embeddings',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        } else {
          resolve(JSON.parse(data));
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ==================== 模式一：纯文本 Batch（使用 input 字段）====================

async function testTextBatch() {
  console.log('=== 模式一：纯文本 Batch ===\n');

  const postData = JSON.stringify({
    model: MODEL_NAME,
    input: [
      '一只橘猫趴在窗台上晒太阳',
      'The capital of China is Beijing.',
      'Gravity is a force that attracts two bodies.'
    ],
    encoding_format: 'float'
  });

  const result = await sendRequest(postData);
  console.log(`返回 ${result.data.length} 条向量`);

  for (const item of result.data) {
    console.log(`[${item.index}] 维度: ${item.embedding.length}, 前3维: [${item.embedding.slice(0, 3).map(v => v.toFixed(4)).join(', ')}]`);
  }

  // 计算相似度
  const v0 = result.data[0].embedding;
  const v1 = result.data[1].embedding;
  console.log(`\n"橘猫" vs "北京" 相似度: ${cosineSimilarity(v0, v1).toFixed(4)}`);
}

// ==================== 模式二：单条图文混合（使用 messages 字段）====================

async function testSingleMultimodal() {
  console.log('\n=== 模式二：单条图文混合（messages 格式）===\n');

  const catImage = imageToBase64('./test-img1.jpg');

  // ⚠️ 关键：必须用 messages 字段，格式和 Chat Completions 完全一致
  // content 数组可以混排 text 和 image_url
  const postData = JSON.stringify({
    model: MODEL_NAME,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'A cute orange cat sleeping by the window' },
          { type: 'image_url', image_url: { url: catImage } }
        ]
      }
    ],
    encoding_format: 'float'
  });

  const result = await sendRequest(postData);
  console.log(`单条图文向量维度: ${result.data[0].embedding.length}`);
  console.log(`前5维: [${result.data[0].embedding.slice(0, 5).map(v => v.toFixed(4)).join(', ')}]`);
}

// ==================== 模式三：图搜图（单条图片 vs 单条图片）====================

async function testImageToImage() {
  console.log('\n=== 模式三：图搜图对比 ===\n');

  const catImage = imageToBase64('./test-img1.jpg');
  const dogImage = imageToBase64('./test-img2.jpg');

  // 分别请求两条单图消息，然后对比相似度
  // ⚠️ /v1/embeddings 不支持 batch 多模态，必须分两次调用
  const req1 = sendRequest(JSON.stringify({
    model: MODEL_NAME,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Represent this image' },
        { type: 'image_url', image_url: { url: catImage } }
      ]
    }],
    encoding_format: 'float'
  }));

  const req2 = sendRequest(JSON.stringify({
    model: MODEL_NAME,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Represent this image' },
        { type: 'image_url', image_url: { url: dogImage } }
      ]
    }],
    encoding_format: 'float'
  }));

  const [res1, res2] = await Promise.all([req1, req2]);
  const vec1 = res1.data[0].embedding;
  const vec2 = res2.data[0].embedding;

  console.log(`cat.jpg 向量维度: ${vec1.length}`);
  console.log(`dog.jpg 向量维度: ${vec2.length}`);
  console.log(`猫 vs 狗 相似度: ${cosineSimilarity(vec1, vec2).toFixed(4)} (越低说明越不像)`);
}

async function testImageToImage_llamacpp() {
  console.log('\n=== 模式三：图搜图对比 ===\n');

  const catImage = imageToBase64('./test-img1.jpg');
  const dogImage = imageToBase64('./test-img2.jpg');

  // 分别请求两条单图消息，然后对比相似度
  // ⚠️ /v1/embeddings 不支持 batch 多模态，必须分两次调用
  const req1 = sendRequest(JSON.stringify({
    model: MODEL_NAME,
    content: [
      { type: 'text', text: 'Represent this image' },
      { type: 'image_url', image_url: { url: catImage } }
    ],
    encoding_format: 'float'
  }));

  const req2 = sendRequest(JSON.stringify({
    model: MODEL_NAME,
    content: [
      { type: 'text', text: 'Represent this image' },
      { type: 'image_url', image_url: { url: dogImage } }
    ],
    encoding_format: 'float'
  }));

  const [res1, res2] = await Promise.all([req1, req2]);
  const vec1 = res1.data[0].embedding;
  const vec2 = res2.data[0].embedding;

  console.log(`cat.jpg 向量维度: ${vec1.length}`);
  console.log(`dog.jpg 向量维度: ${vec2.length}`);
  console.log(`猫 vs 狗 相似度: ${cosineSimilarity(vec1, vec2).toFixed(4)} (越低说明越不像)`);
}


async function testImageToImage1_llamacpp() {
  console.log('\n=== 模式三：图搜图 ===\n');
  const catImage = imageToBase64('./test-img1.jpg');
  const dogImage = imageToBase64('./test-img2.jpg');

  const [res1, res2] = await Promise.all([
    sendRequest(JSON.stringify({
      model: MODEL_NAME,
      content: [
        { type: 'text', text: 'Represent this image' },
        // { type: 'image_url', image_url: { url: catImage } }
      ],
      encoding_format: 'float'
    })),
    sendRequest(JSON.stringify({
      model: MODEL_NAME,
      content: [
        { type: 'text', text: 'Represent this image' },
        // { type: 'image_url', image_url: { url: dogImage } }
      ],
      encoding_format: 'float'
    }))
  ]);

  const sim = cosineSimilarity(res1.data[0].embedding, res2.data[0].embedding);
  console.log(`cat.jpg vs dog.jpg 相似度: ${sim.toFixed(4)}`);
}

// ==================== 模式四：文本搜图片（跨模态检索）====================

async function testTextToImage() {
  console.log('\n=== 模式四：文本搜图片（跨模态）===\n');

  const catImage = imageToBase64('./test-img1.jpg');

  // 文本查询
  const textRes = await sendRequest(JSON.stringify({
    model: MODEL_NAME,
    input: ['a fluffy orange cat on windowsill'],  // 纯文本用 input
    encoding_format: 'float'
  }));

  // 图片文档
  const imgRes = await sendRequest(JSON.stringify({
    model: MODEL_NAME,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Represent the given image' },
        // { type: 'image_url', image_url: { url: catImage } }
      ]
    }],
    encoding_format: 'float'
  }));

  const sim = cosineSimilarity(textRes.data[0].embedding, imgRes.data[0].embedding);
  console.log(`"fluffy orange cat" vs cat.jpg 相似度: ${sim.toFixed(4)} (越高越相关)`);
}




// ==================== 主程序 ====================

(async () => {
  try {
    await testTextBatch();
    await testSingleMultimodal();
    await testImageToImage();
    await testTextToImage();

    // llamacpp 测试
    //await testImageToImage_llamacpp();
    //await testImageToImage1_llamacpp();
  } catch (e) {
    console.error('\n❌ 错误:', e.message);
  }
})();