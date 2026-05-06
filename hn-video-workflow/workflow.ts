import { createAgentSession, defineTool, SessionManager } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { mkdir } from "fs/promises";
import { existsSync } from "fs";

// ── 自定义工具：并发抓取 HN 热门新闻 ─────────────────────────────────────────

const fetchHnTool = defineTool({
	name: "fetch_hn_stories",
	label: "Fetch HN Top Stories",
	description: "从 Hacker News 抓取前 N 条热门新闻，返回 JSON 数组",
	promptSnippet: "Fetch top N stories from Hacker News",
	promptGuidelines: ["当需要获取 Hacker News 新闻时调用此工具"],
	parameters: Type.Object({
		count: Type.Number({ description: "抓取数量，建议100", default: 100 }),
	}),
	execute: async (_id, { count }) => {
		const n = Math.min(count, 100);

		const ids: number[] = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json").then(
			(r) => r.json(),
		);

		const stories = await Promise.all(
			ids.slice(0, n).map((id) =>
				fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then((r) => r.json()),
			),
		);

		const summary = stories
			.filter((s) => s && s.title)
			.map((s) => ({
				id: s.id,
				title: s.title,
				url: s.url ?? `https://news.ycombinator.com/item?id=${s.id}`,
				score: s.score ?? 0,
				by: s.by ?? "unknown",
				comments: s.descendants ?? 0,
				type: s.type ?? "story",
			}));

		return {
			content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
			details: { count: summary.length },
		};
	},
});

// ── 主流程 ────────────────────────────────────────────────────────────────────

async function main() {
	const outputDir = "hn-video-workflow/output";
	await mkdir(`${outputDir}/audio`, { recursive: true });

	console.log("🚀 启动 HN News → 视频工作流\n");

	const { session } = await createAgentSession({
		sessionManager: SessionManager.inMemory(),
		customTools: [fetchHnTool],
		tools: ["bash", "write"],
	});

	// 打印 Agent 实时输出
	session.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
		if (event.type === "tool_execution_start") {
			process.stdout.write(`\n⚙️  [${event.toolName}] 执行中...\n`);
		}
		if (event.type === "tool_execution_end") {
			process.stdout.write(event.isError ? "  ❌ 失败\n" : "  ✅ 完成\n");
		}
	});

	// ── Step 1 + 2：抓取新闻，分析选题，输出解说脚本 ──────────────────────────

	console.log("\n📰 Step 1/3：抓取 HN 新闻并生成解说脚本\n");
	await session.prompt(`
你是一个科技新闻播报员，请完成以下任务：

1. 调用 fetch_hn_stories 工具抓取前 100 条 HN 热门新闻（count=100）

2. 从中挑选 3-4 条最值得关注的内容，综合考虑：
   - 技术影响力和创新性
   - 社区讨论热度（score + comments）
   - 话题新颖性和实用价值

3. 为每条新闻撰写约 120 字的中文解说文本，要求：
   - 语言自然流畅，适合口播
   - 说明新闻的核心内容和为什么重要
   - 不要直接翻译标题，要有分析和见解

4. 将结果以如下格式写入 ${outputDir}/script.json：
{
  "date": "今日日期（YYYY-MM-DD）",
  "segments": [
    {
      "index": 1,
      "title": "新闻标题（中文翻译）",
      "original_title": "原英文标题",
      "url": "原文链接",
      "score": 分数,
      "comments": 评论数,
      "narration": "完整解说文字（约120字）"
    }
  ]
}

写完后输出确认信息：已写入多少条故事，脚本总字数大约多少。
`);

	// ── Step 3：生成 TTS 音频 ────────────────────────────────────────────────────

	console.log("\n\n🎙️  Step 2/3：生成 TTS 音频\n");
	await session.prompt(`
读取 ${outputDir}/script.json，为每个 segment 生成语音音频文件。

按以下优先级尝试 TTS 方案：

**方案 A（优先）：OpenAI TTS API**
如果 OPENAI_API_KEY 环境变量存在：
\`\`\`bash
curl -s https://api.openai.com/v1/audio/speech \\
  -H "Authorization: Bearer $OPENAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"tts-1","input":"<narration文字>","voice":"nova","speed":1.0}' \\
  -o ${outputDir}/audio/segment<N>.mp3
\`\`\`

**方案 B：macOS say 命令**
如果 say 命令存在（macOS）：
\`\`\`bash
say -v Ting-Ting -r 180 "<narration文字>" -o ${outputDir}/audio/segment<N>.aiff
ffmpeg -i ${outputDir}/audio/segment<N>.aiff -ar 44100 ${outputDir}/audio/segment<N>.mp3 -y
\`\`\`

**方案 C：espeak-ng（Linux）**
如果 espeak-ng 存在：
\`\`\`bash
espeak-ng -v zh -s 150 "<narration文字>" -w ${outputDir}/audio/segment<N>.wav
ffmpeg -i ${outputDir}/audio/segment<N>.wav ${outputDir}/audio/segment<N>.mp3 -y
\`\`\`

执行步骤：
1. 先检测可用的 TTS 方案（which say / which espeak-ng / 检查 OPENAI_API_KEY）
2. 为每个 segment 生成对应的 .mp3 文件
3. 用 ffprobe 查询每段音频时长：\`ffprobe -v quiet -show_entries format=duration -of csv=p=0 <文件>\`
4. 将音频信息写入 ${outputDir}/audio_info.json：
{
  "tts_method": "使用的方案",
  "segments": [
    { "index": 1, "file": "segment1.mp3", "duration_seconds": 52.3 }
  ],
  "total_duration_seconds": 总秒数
}

完成后报告：使用了哪种 TTS，各段音频时长。
`);

	// ── Step 4：ffmpeg 合成视频 ─────────────────────────────────────────────────

	console.log("\n\n🎬 Step 3/3：合成视频\n");
	await session.prompt(`
读取 ${outputDir}/script.json 和 ${outputDir}/audio_info.json，用 ffmpeg 合成最终视频。

**合成步骤：**

1. 检测系统是否有 ffmpeg（which ffmpeg）

2. 为每个 segment 生成视频片段：
   - 深蓝色背景（#1a1a2e），1920×1080，30fps
   - 顶部显示新闻编号和标题（白色大字）
   - 中部显示 URL（灰色小字）
   - 底部显示 "Hacker News 日报"水印
   - 时长与对应音频一致

\`\`\`bash
ffmpeg -f lavfi -i color=c=0x1a1a2e:size=1920x1080:rate=30 \\
  -i ${outputDir}/audio/segment<N>.mp3 \\
  -vf "drawtext=text='第<N>条':fontsize=48:fontcolor=0xaaaaaa:x=80:y=80, \\
       drawtext=text='<标题（转义特殊字符）>':fontsize=72:fontcolor=white:x=80:y=200:line_spacing=20, \\
       drawtext=text='<URL>':fontsize=28:fontcolor=0x888888:x=80:y=900, \\
       drawtext=text='HN 日报':fontsize=36:fontcolor=0x444444:x=(w-text_w-80):y=(h-text_h-60)" \\
  -c:v libx264 -preset fast -crf 23 \\
  -c:a aac -b:a 128k \\
  -shortest -y ${outputDir}/seg<N>.mp4
\`\`\`

注意：drawtext 中的特殊字符（冒号、单引号等）需要转义，title 中的单引号用 \\'，冒号用 \\:

3. 生成 filelist.txt（每行 \`file 'seg<N>.mp4'\`），然后拼接：
\`\`\`bash
ffmpeg -f concat -safe 0 -i ${outputDir}/filelist.txt \\
  -c copy -y ${outputDir}/video.mp4
\`\`\`

4. 用 ffprobe 验证最终视频：
\`\`\`bash
ffprobe -v quiet -show_entries format=duration,size -of json ${outputDir}/video.mp4
\`\`\`

5. 输出总结：
   - 视频文件路径
   - 总时长（分:秒）
   - 文件大小
   - 每段标题列表

如果系统没有 ffmpeg，说明需要安装 ffmpeg 并给出安装命令，然后跳过视频合成，只输出音频文件的汇总。
`);

	console.log("\n\n✅ 工作流完成！");
	if (existsSync(`${outputDir}/video.mp4`)) {
		console.log(`📹 视频：${outputDir}/video.mp4`);
	}
	if (existsSync(`${outputDir}/script.json`)) {
		console.log(`📄 脚本：${outputDir}/script.json`);
	}
}

main().catch((err) => {
	console.error("❌ 工作流出错：", err);
	process.exit(1);
});
