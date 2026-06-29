# 完整方案 · 动态引擎 (Dynamic Plan Engine) — 构建规格

> 目标:把 `journey.html` 的「完整方案」从固定 84 天脚本,改成**随实际情况实时重算**的动态引擎。
> 用户决策(2026-06-29):① 变量同时调**训练+饮食**;② 我建一个**会随活动更新的 TDEE 模型**自动算热量。
> 安全定调延续 [[hyrox-plan-site]]:体脂为锚 / 健康优先 / 无牛羊 / 护膝护腰 / 绝不崩溃式节食(有热量与蛋白下限)。

## 一、核心理念
用户每天记录**实际发生的变量**(体重、临时活动如骑行/徒步、饮食含社交餐),引擎据此重算 3 件事 → 重排今日/本周:
1. **负荷** — 临时活动计入急性负荷 LP,本周后续训练自动 保/减/换。
2. **能量** — 额外有氧消耗 + 社交餐盈余,在**整周**内重新平衡(不在单日惩罚),设下限。
3. **体重轨迹** — 实际称重重新拟合趋势 → on track/ahead/behind → 在安全减重率内调整每日热量目标。

## 二、TDEE 模型(Mifflin-St Jeor)
- BMR(女) = 10×kg + 6.25×cm − 5×age − 161
- 当前基线(74kg/165cm/38岁):BMR ≈ 1420 kcal
- **TDEE_today = BMR × 1.3(非运动日常生活基线) + 当天 logged 活动 kcal**
  - 这样每条记录的活动/骑行/徒步都自己加 burn → 真正"动态"。
  - kg 用最近一次称重自动更新 → BMR 随体重下降而下调。

### 活动 kcal(MET 法)
kcal/min = MET × 3.5 × kg / 200。预设 MET(可按强度轻/中/大微调 ±):
跑步 8.3~11 · 骑行 7~10 · 徒步/登山 6~8 · 攀岩 7.5 · 拳击 9~12 · 冲浪 5 · 跑酷 8 · 力量 5 · 蹦床 4 · HYROX 10
活动同时产出 LP(复用 `arLP`:强度×时长×RPE)喂给训练自适应。

## 三、能量平衡 / 整周重平衡
- 安全减重率默认 **~0.5 kg/周 ≈ 每日 −500 kcal 缺口**(≈0.68% 体重/周,上限不超过 0.7%)。
- **下限(健康优先,绝不突破)**:每日摄入 ≥ 1450 kcal;蛋白 ≥ 1.8 g/kg 目标体重(≈100–115 g)。
- **整周重平衡**:追踪本周累计(摄入 − TDEE)。
  剩余天目标 = (本周目标总缺口 − 已发生缺口) ÷ 剩余天数,clamp 到 [下限, TDEE]。
  → 800 kcal 的社交餐盈余 → 把补偿摊到本周剩余几天,任何一天都不低于下限。

## 四、体重轨迹再拟合
- 对 weightLog 做最近 ~2 周线性斜率 → 当前 kg/周 → 外推到地平线 → 对比目标带
  (可持续区 58–60kg / ~17–20% 体脂;15% 体脂只作监督下短暂峰值)。
- 状态:on track / ahead(可放松缺口) / behind(在安全率内 +100~150 kcal/天微调,不加码节食)。

## 五、训练自适应(复用现有)
- 现有 `arRec` 5 档(on_plan / deload_lowimpact / active_recovery / fullrest_deload / medical_referral)保留。
- 改动:临时活动(骑行/徒步等)的 LP 一并计入近 3 天 sumLP3。统一活动日志与 `journeyLoad`。

## 六、UI:今日 + 本周 动态总览面板
- **输入**:① 称重(+体脂% 可选)② 添加活动(类型+时长+强度 → 自动算 kcal+LP)③ 饮食(快记 kcal 或选「社交餐」估值)
- **输出卡**:
  - 体重轨迹(当前速率 / 外推 / 状态)
  - 本周能量(已发生缺口 / 今日调整后目标 / 触发下限时警告)
  - 训练建议(含临时活动负荷的 5 档)
  - 今日/本周重排(调整后的后续几天)

## 七、数据 & 实现
- localStorage 统一键 `journeyDyn:v1` = {profile:{age,cm,targetKg,rateKgWk,floorKcal,proteinFloor}, weights:[{d,kg,bf}], activities:[{d,type,min,tier,rpe,kcal,lp}], meals:[{d,kcal,protein,note,social}]}。
  - 兼容/迁移现有 `journeyDaily:v1` 与 `journeyLoad:v1`(尽量复用,不丢历史)。
- 实现方式:沿用既有模式 —— 写一个 Python 注入脚本,把 CSS + 面板 HTML + JS 引擎插入 `journey.html`(用精确字符串锚点),`node --check` 验证抽取的 script,再 commit + `git push`(自动上线 Pages)。
- 提交信息结尾:`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`,用 `git -c commit.gpgsign=false`。

## 八、验证
- node 逻辑测试:TDEE 数值、MET kcal、整周重平衡 clamp 到下限、轨迹斜率/外推、自适应 5 档边界。
- 关键用例回归:社交餐盈余不把任何一天压到 <1450 kcal;额外骑行 40km 既加 burn(松一点饮食)又加 LP(可能触发 deload)。
