# DateMate · 约会策划

[在线使用](https://bylsxy.github.io/datemate/)。

首页只呈现条件、探索度、场景时间与地点活动卡。地点卡位置固定，点击立即高亮并平滑居中，边缘卡随滚动缩小；计算中的内容使用骨架屏。卡片右上角显示0—100方案契合分，尚未评估完整后续时显示“待评估”。知识、对比、复盘和版本信息通过最底部“三”菜单进入。

## 手动编辑

编辑 `knowledge/scenes.json` 修改地点名称、卡片说明、固定分钟数和活动挂载；编辑 `knowledge/activities.json` 修改活动名称、费用、体力、准备和依赖；编辑 `knowledge/rules.json` 修改推理规则。它们都是UTF-8文本JSON，可以用VS Code或记事本打开。

保存后双击 `重建知识库.cmd`，或执行：

```bash
node tools/build_catalog.mjs
node tools/build_catalog.mjs --check
node tools/build_offline.mjs
```

编译会验证ID、挂载与依赖，再生成 `data/` 中的运行时知识图谱和规则，不覆盖你编辑的 `knowledge/`。自动修订指纹用于拒绝过期复盘。详细字段与例子见[编辑指南](docs/编辑知识库.md)。更新线上版本还需要提交并推送到GitHub。

## 时间与资源

当前知识包含33个地点、68个独立活动、70条挂载关系、47条规则和662条图谱边。全部151份本地语料登记保留，公开内容使用原创摘要与设计参数。

阶段时长只由 `scene.minutes` 决定。无论同地点选0个还是多个活动，当前阶段的起止时间相同；活动继续影响费用、体力、资源、互斥、准备和后续地点选择。转场、时间窗、结束缓冲与预约锚点仍参与约束。金额只在首页末尾显示建议余额。

求解采用确定性有界束搜索、透明效用与Pareto筛选。候选使用同阶段固定评分参考，已确认完整后续与尚未评估的候选分别呈现，未证明全局最优。场地和体验参数可按真实反馈在编辑源中调整。

## 本地验证

```bash
node --test tests/*.test.mjs
node tools/verify_reproducibility.mjs
python -m http.server 8793 --bind 127.0.0.1
```

访问 `http://127.0.0.1:8793/`。原始语料抽取入口 `tools/build_knowledge.py` 默认拒绝覆盖编辑源，显式抽取只写候选临时目录。旧复盘与旧版课程演示不沿用到新版；报告、PPT和录屏材料应在手工知识库定稿后同步。
