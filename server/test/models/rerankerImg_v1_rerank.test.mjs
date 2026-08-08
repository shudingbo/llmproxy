import http from 'http';
import fs from 'fs';
import path from 'path';

// 配置参数
// const HOST = '222.18.149.200';
// const PORT = 1244;
// const PATH = '/rerank';
// const MODEL_NAME = 'qwen-vl-reranker-2b'; // 请确保这是你启动的 VL-Reranker 模型名


const HOST = '127.0.0.1';
const PORT = 3000;
const PATH = '/rerank'; // 注意这里是 /v1/rerank
const MODEL_NAME = 'ranker-vl';

// 辅助函数：将本地图片转换为 Base64 Data URI
function imageToBase64URI(filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            console.error(`图片文件不存在: ${filePath}`);
            return null;
        }
        const ext = path.extname(filePath).toLowerCase();
        // 常见图片格式映射
        const mimeTypes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
        const mimeType = mimeTypes[ext] || 'application/octet-stream';
        
        const imageBuffer = fs.readFileSync(filePath);
        const base64 = imageBuffer.toString('base64');
        return `data:${mimeType};base64,${base64}`;
    } catch (e) {
        console.error('读取图片失败:', e.message);
        return null;
    }
}

// 假设有一张本地图片 (请确保同目录下有这个图片，或修改路径)
const imagePath = './test-img1.png'; 
const imageURI = imageToBase64URI(imagePath);

const imagePath2 = './test-img2.jpg'; 
const imageURI2 = imageToBase64URI(imagePath2);

if (!imageURI) {
    console.error("请确保目录下有 test.jpg 文件用于测试。");
    process.exit(1);
}

// 构造请求体
// 对于 VL-Reranker，documents 数组中的每一项可以是一个对象，包含 text 和 image_url
const postData = JSON.stringify({
    model: MODEL_NAME,
    query: "哪个图片里有猫", // 纯文本查询
    documents: [
        {
            content: [
                {
                    type: "image_url",
                    image_url: {
                        url: imageURI // 这里填入 Base64 Data URI
                    }
                },
                // {
                //     type: "text",
                //     text: "这是一张猫的图片"
                // }
                // 如果图片对应有文本说明，也可以在这里添加: { type: "text", text: "这是图片的描述" }
            ]
        },
        {
            content: [
                {
                    type: "image_url",
                    image_url: {
                        url: imageURI // 这里填入 Base64 Data URI
                    }
                },
                {
                    type: "text",
                    text: "一只橘猫"
                }
            ]
        },
        {
            content: [
                {
                    type: "image_url",
                    image_url: {
                        url: imageURI2 // 这里填入 Base64 Data URI
                    }
                },
                // {
                //     type: "text",
                //     text: "这是一张狗的图片"
                // }
            ]
        },
    ],
    // 返回最高的 2 个文档
    top_n: 3
});

// const postData = JSON.stringify({
//     model: MODEL_NAME,
//     query: "What is in the image?", // 纯文本查询
//     documents: [
//         {
//             // 文档1：包含文本和图片（多模态文档）
//             text: "This is a photo of a cat.", 
//         },
//         {
//             // 文档2：纯文本文档
//             text: "This is a document about cars.",
//         }
//     ],
//     top_n: 2
// });

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

console.log(`正在连接 ${HOST}:${PORT} 测试 VL-Reranker...`);

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
                //console.log(JSON.stringify(result, null, 2));

                if (result.results) {
                    console.log('\n--- 重排序结果 ---');
                    result.results.forEach((item, i) => {
                        console.log(`[${i + 1}] 文档索引: ${item.index} | 分数: ${(item.relevance_score || item.score).toFixed(4)}`);
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

req.on('error', (e) => {
    console.error(`\n请求出错: ${e.message}`);
});

req.write(postData);
req.end();
