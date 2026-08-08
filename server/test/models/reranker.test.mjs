// 使用 import 语法导入内置模块
import http from 'http';

// 配置参数
const HOST = '222.18.149.200';
const PORT = 1244;
const PATH = '/v1/score';
// const PATH = '/v1/rerank';
const MODEL_NAME = 'qwen-vl-reranker-2b';

// const HOST = '127.0.0.1';
// const PORT = 3000;
// //const PATH = '/v1/score';
// const PATH = '/rerank';
// const MODEL_NAME = 'ranker-vl';

// 构造请求体
const postData = JSON.stringify({
    model: MODEL_NAME,
    text_1:[
        "什么是光合作用？",
        "如何做红烧肉？",
        "太阳系有几大行星？"
    ],
    text_2: [
        "光合作用是植物利用阳光将二氧化碳和水转化为有机物和氧气的过程。",
        "红烧肉是一道经典的中式菜肴，主要原料是五花肉。",
        "冥王星被降级后，太阳系目前公认有八大行星。"
    ]
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

console.log(`正在连接 ${HOST}:${PORT} 测试模型 ${MODEL_NAME}...`);

// 发起请求
const req = http.request(options, (res) => {
    let data = '';

    // 接收数据块
    res.on('data', (chunk) => {
        data += chunk;
    });

    // 响应接收完毕
    res.on('end', () => {
        console.log(`\n状态码: ${res.statusCode}`);
        
        if (res.statusCode === 200) {
            try {
                const result = JSON.parse(data);
                console.log('测试成功！返回结果：');
                console.log(JSON.stringify(result, null, 2));
                
                // 打印具体的分数
                if (result.data && result.data[0] && result.data[0].score !== undefined) {
                    console.log(`\n>>> 相关性分数: ${result.data[0].score}`);
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
        console.error('无法连接到服务器，请检查地址和端口是否正确。');
    }
});

// 发送请求体
req.write(postData);
req.end();
