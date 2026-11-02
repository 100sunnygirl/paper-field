import type { BatchStep, SqlEngine } from "./engine";
import { NOTE_KINDS } from "./types";

const DOMAIN_MM = "11111111-1111-4111-8111-111111111111";
const DOMAIN_AL = "22222222-2222-4222-8222-222222222222";
const PAPER_LLAVA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const PAPER_CLIP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const PAPER_INSTRUCT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const PAPER_FILENAME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";

function note(
  steps: BatchStep[],
  paperId: string,
  kind: string,
  content: string,
  source: "manual" | "llm",
  edited: number,
  at: string,
) {
  steps.push({
    sql: `INSERT INTO notes (id, paper_id, kind, content, source, user_edited, revised_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    params: [`note-${paperId}-${kind}`, paperId, kind, content, source, edited, at],
  });
}

export async function seedIfEmpty(engine: SqlEngine): Promise<void> {
  // 持久「已初始化」标记：只要写过一次，之后即使删光所有领域也不再灌入演示数据。
  // 存量库（已有数据但从未写标记）首次 init 时也会补上标记，随后才检查是否需要播种。
  const meta = await engine.select<{ c: number }>(
    "SELECT COUNT(*) AS c FROM app_meta WHERE key = 'seeded'",
  );
  if (Number(meta[0]?.c ?? 0) > 0) return;
  const marker: BatchStep = {
    sql: "INSERT OR REPLACE INTO app_meta (key, value) VALUES ('seeded', ?)",
    params: [new Date().toISOString()],
  };

  const rows = await engine.select<{ c: number }>("SELECT COUNT(*) AS c FROM domains");
  if (Number(rows[0]?.c ?? 0) > 0) {
    await engine.batch([marker]);
    return;
  }
  // 标记与演示数据同一个事务：中途崩溃时两者都不落库，下次启动完整重来。
  const steps: BatchStep[] = [marker];

  const at = "2024-11-02T09:00:00.000Z";

  steps.push({
    sql: `INSERT INTO domains (id, name, code, summary, sort_order, created_at) VALUES
      (?, '多模态', 'MM-01', '视觉-语言对齐、指令微调与开源多模态基座。', 1, ?),
      (?, '指令对齐', 'AL-02', '人类反馈、宪法式对齐与可跟随指令的语言模型。', 2, ?)`,
    params: [DOMAIN_MM, at, DOMAIN_AL, at],
  });

  steps.push({
    sql: `INSERT INTO papers (
      id, domain_id, title, title_zh, abstract, year, venue, doi, arxiv_id, pdf_url,
      code_url, code_open_source, project_page, reading_status, read_at, llm_prepared_at,
      notes_drafted_by_llm, user_notes_touched, tags, labs, created_at, updated_at
    ) VALUES
    (?, ?, ?, ?, ?, 2023, 'NeurIPS', '10.48550/arXiv.2304.08485', '2304.08485',
     'https://arxiv.org/pdf/2304.08485', 'https://github.com/haotian-liu/LLaVA', 'open',
     'https://llava-vl.github.io', 'read', ?, ?, 1, 1, ?, ?, ?, ?),
    (?, ?, ?, ?, ?, 2021, 'ICML', '10.48550/arXiv.2103.00020', '2103.00020',
     'https://arxiv.org/pdf/2103.00020', 'https://github.com/openai/CLIP', 'open',
     'https://openai.com/research/clip', 'reading', NULL, ?, 0, 0, ?, ?, ?, ?),
    (?, ?, ?, ?, ?, 2022, 'NeurIPS', '10.48550/arXiv.2203.02155', '2203.02155',
     'https://arxiv.org/pdf/2203.02155', NULL, 'closed',
     NULL, 'unread', NULL, NULL, 0, 0, ?, ?, ?, ?)`,
    params: [
      PAPER_LLAVA,
      DOMAIN_MM,
      "Visual Instruction Tuning",
      "视觉指令微调",
      "LLaVA connects a CLIP vision encoder with a Vicuna language model and uses GPT-4 generated multimodal instruction data so the model can follow visual instructions in open-ended dialogue.",
      "2024-09-18T10:00:00.000Z",
      at,
      JSON.stringify(["llava", "instruction-tuning", "open-source"]),
      JSON.stringify([{ name: "Liu Lab", institution: "University of Wisconsin–Madison" }]),
      at,
      "2024-09-18T10:00:00.000Z",
      PAPER_CLIP,
      DOMAIN_MM,
      "Learning Transferable Visual Models From Natural Language Supervision",
      "从自然语言监督中学习可迁移视觉模型",
      "CLIP jointly trains an image encoder and a text encoder on 400 million image-text pairs, enabling zero-shot visual classification by matching images to natural language class descriptions.",
      at,
      JSON.stringify(["clip", "contrastive", "zero-shot"]),
      JSON.stringify([{ name: "OpenAI", institution: "OpenAI" }]),
      at,
      at,
      PAPER_INSTRUCT,
      DOMAIN_AL,
      "Training language models to follow instructions with human feedback",
      "用人类反馈训练语言模型遵循指令",
      "InstructGPT fine-tunes GPT-3 with supervised instruction data and PPO from human preference comparisons so the model better follows user intent and reduces unhelpful outputs.",
      JSON.stringify(["rlhf", "instructgpt", "alignment"]),
      JSON.stringify([{ name: "Alignment team", institution: "OpenAI" }]),
      at,
      at,
    ],
  });

  const authors: Array<[string, string, string | null, string | null]> = [
    ["au-liu", "Haotian Liu", "University of Wisconsin–Madison", "Liu Lab"],
    ["au-li", "Chunyuan Li", "Microsoft Research", "Microsoft Research"],
    ["au-wu", "Qingyang Wu", "Columbia University", null],
    ["au-lee", "Yong Jae Lee", "University of Wisconsin–Madison", "Liu Lab"],
    ["au-rad", "Alec Radford", "OpenAI", "OpenAI"],
    ["au-kim", "Jong Wook Kim", "OpenAI", "OpenAI"],
    ["au-hall", "Chris Hallacy", "OpenAI", "OpenAI"],
    ["au-ouyang", "Long Ouyang", "OpenAI", "OpenAI"],
    ["au-wu2", "Jeff Wu", "OpenAI", "OpenAI"],
    ["au-jiang", "Xu Jiang", "OpenAI", "OpenAI"],
  ];
  for (const [id, name, affiliation, lab] of authors) {
    steps.push({
      sql: `INSERT INTO authors (id, name, name_zh, affiliation, lab, homepage, orcid)
       VALUES (?, ?, NULL, ?, ?, NULL, NULL)`,
      params: [id, name, affiliation, lab],
    });
  }

  const links: Array<[string, string, number, number]> = [
    [PAPER_LLAVA, "au-liu", 0, 1],
    [PAPER_LLAVA, "au-li", 1, 0],
    [PAPER_LLAVA, "au-wu", 2, 0],
    [PAPER_LLAVA, "au-lee", 3, 0],
    [PAPER_CLIP, "au-rad", 0, 1],
    [PAPER_CLIP, "au-kim", 1, 0],
    [PAPER_CLIP, "au-hall", 2, 0],
    [PAPER_INSTRUCT, "au-ouyang", 0, 1],
    [PAPER_INSTRUCT, "au-wu2", 1, 0],
    [PAPER_INSTRUCT, "au-jiang", 2, 0],
  ];
  for (const [paperId, authorId, order, corresponding] of links) {
    steps.push({
      sql: `INSERT INTO paper_authors (paper_id, author_id, sort_order, is_corresponding)
       VALUES (?, ?, ?, ?)`,
      params: [paperId, authorId, order, corresponding],
    });
  }

  note(
    steps,
    PAPER_LLAVA,
    "remarks",
    "开源权重与数据配方都相对完整，适合作为多模态指令微调的对照基线。",
    "manual",
    1,
    at,
  );
  note(
    steps,
    PAPER_LLAVA,
    "summary",
    "用投影层把 CLIP 视觉特征接到 Vicuna，再用 GPT-4 合成的图文指令数据做端到端微调，让语言模型能围绕图像回答与推理。",
    "llm",
    1,
    at,
  );
  note(
    steps,
    PAPER_LLAVA,
    "highlights",
    "- 视觉编码器冻结、只训投影与 LLM，训练成本可控。\n- 公开模型、代码与视觉指令数据。\n- 对话式视觉问答，而不是单标签分类。",
    "llm",
    1,
    at,
  );
  note(
    steps,
    PAPER_LLAVA,
    "weaknesses",
    "- 指令数据依赖 GPT-4，分布与评测可能循环。\n- 细粒度定位、OCR 仍弱于专用模型。",
    "manual",
    1,
    at,
  );
  note(
    steps,
    PAPER_LLAVA,
    "implications",
    "后续工作多沿「冻结视觉骨干 + 轻量对齐 + 公开指令数据」展开。开源状态明确，适合作为领域内对照单元。",
    "manual",
    1,
    at,
  );

  steps.push({
    sql: `INSERT INTO papers (
      id, domain_id, title, title_zh, abstract, year, venue, doi, arxiv_id, pdf_url,
      code_url, code_open_source, project_page, reading_status, read_at, llm_prepared_at,
      notes_drafted_by_llm, user_notes_touched, tags, labs, field_sources, created_at, updated_at
    ) VALUES (
      ?, ?, ?, NULL, '', NULL, NULL, NULL, NULL, NULL,
      NULL, 'unknown', NULL, 'unread', NULL, NULL,
      0, 0, '[]', '[]', ?, ?, ?
    )`,
    params: [PAPER_FILENAME, DOMAIN_MM, "visual-instruction-tuning.pdf", JSON.stringify({ title: "file" }), at, at],
  });

  for (const paperId of [PAPER_CLIP, PAPER_INSTRUCT, PAPER_FILENAME]) {
    for (const kind of NOTE_KINDS) {
      steps.push({
        sql: `INSERT INTO notes (id, paper_id, kind, content, source, user_edited, revised_at)
         VALUES (?, ?, ?, '', 'manual', 0, ?)`,
        params: [`note-${paperId}-${kind}`, paperId, kind, at],
      });
    }
  }
  await engine.batch(steps);
}
