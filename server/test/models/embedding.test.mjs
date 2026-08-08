// test_embedding.mjs
import http from 'http';

// const HOST = '222.18.149.200';
// const PORT = 1242;
// const PATH = '/v1/embeddings';
// // const MODEL_NAME = 'qwen-embedding-0.6';
// // const MODEL_NAME = 'qwen3-embedding-4b';
// const MODEL_NAME = 'qwen-vl-embedding-2b';

const HOST = '127.0.0.1';
const PORT = 3000;
const PATH = '/v1/embeddings';
const MODEL_NAME = 'embedding-vl';



// 请求体：符合 OpenAI Embeddings API 兼容格式
// vLLM 的 /v1/embeddings 支持标准 OpenAI embeddings 协议
const postData = JSON.stringify({
  model: MODEL_NAME,
  input: [
    'The capital of China is Beijing.',
    'Gravity is a force that attracts two bodies towards each other.'
  ],
  encoding_format: 'float'
});

const options = {
  hostname: HOST,
  port: PORT,
  path: PATH,
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData)
  }
};

console.log(`正在连接 ${HOST}:${PORT} 测试 embedding 模型 ${MODEL_NAME} ...`);

const req = http.request(options, (res) => {
  let data = '';

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    console.log(`\nHTTP 状态码: ${res.statusCode}`);

    if (res.statusCode === 200) {
      try {
        const result = JSON.parse(data);
        console.log('请求成功，返回结果结构：');
        console.log(result);

        // 标准返回：{ object: 'list', data: [ { object: 'embedding', embedding: [...], index: 0 } ], model: '...', usage: {...} }

        if( result?.data ) {
          for( let it of result.data ) {
            const emb = it.embedding;
            console.log(`\n拿到第 ${it.index} 条 embedding 向量，长度: ${emb.length}`);
            console.log(`前 5 个元素: ${emb.slice(0, 5).join(', ')}`);
          }
        }
      } catch (e) {
        console.error('解析 JSON 失败:', e.message);
        console.log('原始响应:', data);
      }
    } else {
      console.error('请求失败，响应内容:');
      console.log(data);
    }
  });
});

req.on('error', (e) => {
  console.error(`\n请求出错: ${e.message}`);
  if (e.code === 'ECONNREFUSED') {
    console.error('无法连接到服务器，请确认地址和端口正确，并且 vLLM 服务已启动。');
  }
});

req.write(postData);
req.end();
