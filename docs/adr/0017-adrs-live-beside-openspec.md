# ADR-0017: ADR 落在仓库根 `adr/`,与 `openspec/` 平级,不可变,靠 Supersedes 演进

- **Status**: accepted
- **Date**: 2026-10-05
- **Supersedes**: none

`docs/` 原先混居三类东西,只有一类真该进 spec:9 篇 ADR 是**决策历史**(为什么这么定,
被否决的方案,后来推翻的结论),`page-actions.md` 是**规格**,`docs/agents/` 三篇是**工作手册**.
用户 2026-10-05 要求 `docs/` 彻底消失,于是要回答:ADR 到底该放在哪,由谁守.

查下来这个缺口是**社区已识别的**:OpenSpec 默认 `spec-driven` schema 在 archive 时只把
spec delta 往前同步,`design.md` 的理由随 change 一起沉进档案,未来的 proposal 看不见
(Fission-AI/OpenSpec issue #557 请求加 ADR 支持,官方在考虑,默认 schema 至今没有).
社区方案是 `spec-driven-with-adr` 自定义 schema(intent-driven-dev/openspec-schemas,
由 OpenSpec 技术顾问 Hari Krishnan 构建):第五个 artifact 是 `adr`,持久 ADR 写到
**仓库根 `/adr/`,与 `openspec/` 平级,不嵌套在里面**.

## 决定

1. **ADR 落仓库根 `adr/`**,与 `openspec/` 平级,文件名 `NNNN-kebab-title.md`(4 位序号,
   全仓单调递增,不复用).放进 `openspec/changes/` 会被 archive 掉,放进 `openspec/` 内部
   归属含混--两者都达不到"跨 change 存活".
2. **换 schema `spec-driven-with-adr`**,vendor 在 `openspec/schemas/spec-driven-with-adr/`
   (项目级,`openspec/config.yaml` 的 `schema:` 启用).artifact 变 5 个:
   `proposal → specs → design → adr → tasks`.`adr` 步产出两样:变更内的 `adr.md` 审阅清单
   (记"读过哪些在作数的 ADR,本 change 新开了哪几篇")+ 需要时在 `adr/` 新开一篇.
   `tasks` 要 `specs` 与 `adr` 都齐了才开始--**顺序上强制"先看旧账,再排活"**.
3. **接受过的 ADR 不可变,靠 `Supersedes:` 演进**:要推翻就写新一篇,在它的 `Supersedes:`
   里点名旧篇,旧篇原样留着.design 步靠遍历这个图判断哪几篇还作数--被指名的旧篇不再
   约束新设计,只作历史.
4. **spec 承载"必须怎样"(CI 守),ADR 承载"为什么"(人读)**.两者重复是**有意的**:
   同一个常量在 ADR 里讲来历,在 spec 里当 requirement,在测试里被钉住,三处会漂,接受--
   漂了由 `pnpm quality` 的测试先喊.
5. **既有 9 篇只补 `Status` / `Date` / `Supersedes` 三行头,正文一字不改**(用户拍板).
   其中 0011 的一句被 0012 局部修订,那是**局部修订不是整体取代**,所以 0011 的
   `Supersedes` 仍写 `none`(整篇标成 not-in-force 会丢掉"唯一端点 `POST /mcp`,被动到底"
   这些仍然有效的约束),关系写在 0012 正文与变更的 `adr.md` 清单里.
6. **风格 `madr-minimal`**,记在 `.agents/skills/architectural-decision-records/preferences.md`,
   章节名沿用既有 9 篇的混排(`## 决定` / `## Considered Options` / `## Consequences`),
   正文中文(与 `openspec/config.yaml` 的 `Language: zh-CN` 一致).配套 skill
   `architectural-decision-records` 与 `openspec-git-discipline` 装在 `.agents/skills/`.

## Considered Options

- **ADR 全部并进 `openspec/specs/` 当 requirement**:否决--那是把"为什么"塞进"是什么",
  spec 会变成决策日记,而且丢掉"这个决定后来被推翻了"这个维度(ADR-0002 的三态状态机作废,
  ADR-0012 修订 0011 一句,都是这类记录).
- **放 `openspec/decisions/`**:否决--嵌套在 `openspec/` 内,`openspec validate` 不看它,
  与 `changes/` 的 archive 边界关系含混.
- **留在 `docs/adr/` 不动**:否决--`docs/` 没有任何门守着,已经躺过两处死引用;
  且与另两类内容混居,找"必须怎样"要跨两棵树.
- **换 `spec-driven-with-adr` schema**:采用,但认下它的代价(见下).

## Consequences

- Good:archive 不再丢理由;design 步开篇就被强制读一遍在作数的 ADR;`docs/` 消失;
  ADR-0012/0015/0016 三篇零 requirement 覆盖的缺口补成了 `backend` 的 requirement.
- Good:切换对**在飞的 change 零破坏**--每个 change 的 `.openspec.yaml` 记着自己的
  schema,旧 change 钉在创建时那一个(`docs-into-openspec` 迁移前是 4 artifact,迁移后 5 个).
- Good:`.opencode/` 的 `/opsx-*` 命令**不用重新生成**--artifact 顺序是从
  `openspec status --json` 读的,schema 无关;`openspec update --force` 跑完零改动.
- Bad:`schema` 命令 CLI 自己标着 `experimental and may change`,升级可能变.
- Bad:vendor 了 8 个第三方文件进仓(schema.yaml + 5 模板 + README + skills.txt),
  上游更新要自己跟;两个配套 skill 同理.
- Bad:每个 change 多一个 `adr.md`,没重大决策时也要写三行"无"--便宜,但是个必答题.
- Bad:ADR 里的数字(`MAX_RESULT_CHARS = 64 * 1024` 这类)**不被 `openspec validate` 校验**,
  可能与代码漂移.对策就是第 4 条:同一个常量在 spec 里当 requirement,在测试里钉住.
- Follow-up:`openspec/schemas/` 与 `.agents/skills/` 是 vendor 的,升级前先跑
  `openspec schema validate spec-driven-with-adr`.
