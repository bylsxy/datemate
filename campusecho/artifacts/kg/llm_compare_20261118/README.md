# LLM-A* 固定子集对照

- 数据：`data/kg` 的 test split，固定分层 12 题，seed `20261118`
- 模型：`Qwen2.5-1.5B-Instruct-Q4_K_M`（llama.cpp OpenAI 兼容端点）
- 每方法：A*、LLM-A*、错误 reward 的 LLM-A*-wrong
- 运行：`tools/run_llm_experiment.py --limit 12 --max-llm-calls 6`
- 约束：LLM 只看公开问题、当前路径和候选动作；不接收私有答案
- 结果：`summary.json`、`records.jsonl`、`report_table.md`

正常预算下，LLM-A* 的平均扩展节点为 3.333，A* 为 4.000；错误 reward 回升到 3.833。紧预算实验见 `artifacts/kg/llm_compare_budget_20261118`。
