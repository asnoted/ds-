# ADR-0019: 换回 Matt 的技能流程,OpenSpec 退役,spec 删除,ADR 回到 `docs/adr/`

- **Status**: accepted
- **Date**: 2026-10-07
- **Supersedes**: ADR-0017

2026-10-04 起本仓用 OpenSpec(换掉 Trellis)管需求:`/opsx-propose` → `/opsx-apply` → `/opsx-archive`,
spec 住 `openspec/specs/`,ADR 住与它平级的根目录 `adr/`(ADR-0017).2026-10-07 用户拍板:**没必要用
OpenSpec,换回 Matt(mattpocock/skills)那套**.

这一天之前的半个月里,这条流程的账是这样的:

- 建了 6 篇 spec(`backend` / `continuation` / `conventions` / `frontend` / `local-tools` / `site-dom`),
  归档 14 个 change,另 vendor 了一份社区 schema `spec-driven-with-adr`;
- 每个 change 要写 proposal / specs / design / adr / tasks 五件产物再走 propose → apply → archive,
  而改动本身常常只有几十行;
- 同一件事被写了几遍:delta spec,design,ADR 清单,tasks,PR 描述,issue 评论;
- 流程自己的坑吃掉了不少时间:MODIFIED 是整块替换(漏抄一段 requirement 开头,同步后才发现),
  两个 change 改同一条 requirement 时归档顺序会互相覆盖(逼得先归档一个才能起另一个提案);
- OpenSpec 是**拉取式**的,不会主动往对话里灌上下文(`config.yaml` 的 `context` 只有语言约定).

## 决定

1. **技能流程换成 Matt 的**:从上游 `mattpocock/skills` 重建(不从本仓旧提交恢复),装在 `.agents/skills/`,
   `npx skills@latest add mattpocock/skills -a opencode -s '*' -y --copy` 装,`skills-lock.json` 记版本,
   `npx skills update` 更新.`.agents/skills/` **只留 Matt 的**(以 `skills-lock.json` 为准),非 Matt 的技能
   (原有的 `architectural-decision-records`,`openspec-git-discipline`)一并删除.日常流:想法不清 `/grill-with-docs` → 成型 `/to-spec`(发成 GitHub issue)→
   `/to-tickets` → `/implement`(或 `/implement-spec`);坏了 `/diagnosing-bugs`;过 issue 用 `/triage`.
2. **OpenSpec 整个退役**:删 `openspec/`(含 6 篇 spec,归档 change,vendor 的 schema,`config.yaml`),
   `.opencode/` 里生成的 `/opsx-*` 命令与技能,`openspec-git-discipline` 技能,CI 的 `spec` 工作流,
   `@fission-ai/openspec` 依赖与各处忽略项.
3. **spec 全部删除,不转存**."必须怎样"的场景不再有专门的住处,改由 `GLOSSARY.md`,ADR,测试,
   `protocol/fixtures/action.json` 契约样例与 `protocol/evidence/controls.json` 存证承载.要读旧 spec:
   `git show 0214968:openspec/specs/<能力>/spec.md`(能力:`backend` / `continuation` / `conventions` / `frontend` / `local-tools` / `site-dom`).
4. **文档布局回到上游约定**:词汇表 `CONTEXT.md` → `GLOSSARY.md`;ADR `adr/` → `docs/adr/`;
   issue 追踪 / 分诊标签 / 领域文档的规则写在 `docs/agents/*.md`,AGENTS.md 里只留指针(`## Agent skills`).
   这就是 `/setup-matt-pocock-skills` 的产物,也是上游各技能硬引用的路径.
5. **这条取代 ADR-0017**:其"ADR 落仓库根 `adr/`,与 `openspec/` 平级"的前提(OpenSpec)已不在,位置回到 `docs/adr/`.
   ADR-0017 的另一半--ADR 不可变,靠 `Supersedes` 演进--**原样沿用**(写进了 `docs/agents/domain.md`).
   ADR-0017 正文原样留着,只是随目录挪了位置.
6. **ADR-0018(存证)不受影响**:它要求的原样存证,对拍测试,真机对账都在代码与 `scripts/` 里,不依赖 OpenSpec.
   `src/lib/evidence.test.ts` 与 `tests/test_evidence.py` 继续守它.

## Considered Options

- **留着 OpenSpec,只是少用**:否决--半用半不用最糟,主 spec 会慢慢过时,且 AGENTS.md 与 CI 仍要为它维护纪律.
- **把 6 篇 spec 挪到 `docs/specs/` 当纯文档**:否决(用户明确选"全部删除")--没有工具校验的 spec 必然过时,
  过时的契约比没有契约更误导;契约样例与存证是有测试守着的,那才是活的.
- **从本仓旧提交恢复 Matt 技能**:否决(用户选"重建")--旧版是 2026-10-04 前后的快照,上游已加 `chief-of-staff`,
  改词汇表为 `GLOSSARY.md` 等;`skills-lock.json` 让之后能 `update`.
- **保留 `CONTEXT.md` 与根 `adr/`,在 `docs/agents/domain.md` 里声明布局**:否决--上游 45 处硬引用 `GLOSSARY.md`,
  逐个改技能等于 fork;按上游路径改文件名(一次性)更省.

## Consequences

- Good:流程变轻--想法到 issue 到实现三步,不再每个改动五件产物;上下文由 `AGENTS.md` + 技能自己带.
- Good:技能与词汇表 / ADR 路径与上游一致,`npx skills update` 能直接升级,不用手工对账.
- Bad:**6 篇 spec 里的"必须怎样"场景丢了**(git 历史里还在).尤其 `frontend` 的页面动作契约(定位口径,闸,失败码取舍)
  与 `site-dom` 的锚点契约现在只剩代码注释,测试与 `action.json`--读代码的人看不到"为什么这么定"的完整叙述.
  代码注释里仍有若干"见 `site-dom` / `frontend` spec"的指引(`src/lib/page.ts`,`messages.ts` 等),现已指向历史.
- Bad:**仓库现在没有任何 CI 检查**--原来唯一的工作流就是 OpenSpec 校验(`openspec validate`),它随 OpenSpec 一起删了;
  `pnpm quality`(eslint + tsc + vitest + prettier + ruff + pytest)只在本地跑.是否补一个跑 `pnpm quality` 的工作流,另议.
- Bad:已接受的 ADR 里个别正文仍提到 `CONTEXT.md`(如 ADR-0002),`adr/` 路径或 OpenSpec--**不改**(ADR 不可变),
  以本篇为准:`CONTEXT.md` 即现在的 `GLOSSARY.md`.
