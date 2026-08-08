import http from 'http';

// 配置参数
// const HOST = '222.18.149.200';
// const PORT = 1244;
// const PATH = '/rerank'; // 注意这里是 /v1/rerank
// const MODEL_NAME = 'qwen-vl-reranker-2b';

const HOST = '127.0.0.1';
const PORT = 3000;
const PATH = '/rerank'; // 注意这里是 /v1/rerank
const MODEL_NAME = 'ranker-vl';

// 构造请求体
// /v1/rerank 接口标准字段：query (字符串) 和 documents (字符串数组)
const postData = JSON.stringify({
    model: MODEL_NAME,
    query: 'What is the capital of China?',
    documents: [
        'Shanghai is the biggest city in China.', // 不太相关
        'The capital of China is Beijing.',      // 相关文档
        'Apples are usually red or green.'        // 无关文档
    ],
    top_n: 2 // 返回前 N 个结果，可选
});

// 设置请求选项
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

console.log(`正在连接 ${HOST}:${PORT} 测试 /v1/rerank 接口...`);

// 发起请求
const req = http.request(options, (res) => {
    let data = '';

    res.on('data', (chunk) => {
        data += chunk;
    });

    res.on('end', () => {
        console.log(`\n状态码: ${res.statusCode}`);
        
        if (res.statusCode === 200) {
            try {
                const result = JSON.parse(data);
                console.log('测试成功！返回结果：');
                console.log(JSON.stringify(result, null, 2));

                // 解析并展示排序结果
                // 标准返回格式通常包含 results 数组，内含 index, relevance_score (或 score)
                if (result.results && result.results.length > 0) {
                    console.log('\n--- 重排序结果 (按相关性从高到低) ---');
                    result.results.forEach((item, i) => {
                        // 注意：不同模型返回的字段名可能是 relevance_score 或 score
                        const score = item.relevance_score || item.score; 
                        const docIndex = item.index;
                        
                        console.log(`[${i + 1}] 文档索引: ${docIndex} | 分数: ${score.toFixed(4)}`);
                        // 如果返回结果中包含 document text，也可以打印
                        if (item.document && item.document.text) {
                            console.log(`    内容: ${item.document.text}`);
                        }
                    });
                }
            } catch (e) {
                console.error('解析 JSON 失败:', e.message);
                console.log('原始响应:', data);
            }
        } else {
            console.error('请求失败，响应内容:', data);
        }
    });
});

// 处理请求错误
req.on('error', (e) => {
    console.error(`\n请求出错: ${e.message}`);
    if (e.code === 'ECONNREFUSED') {
        console.error('无法连接到服务器，请检查地址和端口。');
    }
});

// 发送请求体
req.write(postData);
req.end();
