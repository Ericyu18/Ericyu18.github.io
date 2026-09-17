import assert from 'node:assert/strict';
import test from 'node:test';
import { actionMap, actionTasks } from '../src/data/actions.ts';
import { demoProfiles } from '../src/data/demoProfiles.ts';
import { phaseWeeksV22, supplementalFields } from '../src/data/modelV22.ts';
import { questionMap, questions, questionsByStep } from '../src/data/questions.ts';
import { missingConditionalAnswers, missingRequiredQuestions, supplementalProgress } from '../src/lib/assessment.ts';
import {
  calculateCompetencyScores,
  calculatePreferenceFit,
  calculateWeightedRoleScore,
  generateRecommendation,
  planActionTasks,
  rankRoles,
  validateActionGraph,
} from '../src/lib/scoring.ts';
import { createRecommendationSubmitter, RESULT_META_KEY } from '../src/lib/submission.ts';
import type { AnswerRecord, CompetencyScore, RecommendationResult, Timeframe } from '../src/types/index.ts';

const completeFollowups: AnswerRecord = {
  role_experience_tags: ['none'],
  experience_market_scope: 'not_applicable',
  content_work_scope: 'none',
  portfolio_role_scope: 'none',
  portfolio_authenticity: 'not_applicable',
  display_status: 'not_viewable',
};

test('V2.2问卷保持18题、稳定ID唯一并拆分Q07A/Q07B', () => {
  assert.equal(questions.length, 18);
  assert.equal(new Set(questions.map((question) => question.id)).size, 18);
  assert.ok(questionMap.Q07A && questionMap.Q07B);
  assert.equal(questionMap.Q07, undefined);
});

test('[REG-22-03] SYN-STU-04数据3.0、AI0.0汇总为1.5且结果保留三个显示子分', () => {
  const answers: AnswerRecord = { Q07A: 3, Q07B: 0, ...completeFollowups };
  const scores = calculateCompetencyScores(answers);
  assert.equal(scores.find((item) => item.id === 'data_ai')?.score, 1.5);
  const detail = generateRecommendation({ ...answers, P04: 8, P05: 0, Q10: 0 }).abilityEvidence
    .find((item) => item.competencyId === 'data_ai');
  assert.deepEqual(detail?.componentScores?.map((item) => item.score), [3, 0, 1.5]);
});

test('单项行为证据形成0—4能力分，岗位加权和偏好计算可复算', () => {
  const profile = demoProfiles[1];
  const scores = calculateCompetencyScores(profile.answers);
  assert.ok(scores.every((item) => item.score >= 0 && item.score <= 4));
  assert.equal(calculateWeightedRoleScore(scores, 'localization'), 60.7);
  assert.equal(calculatePreferenceFit(profile.answers, 'localization'), 62.5);
});

test('[REG-22-02] SYN-STU-06社区方向保留41.4基础分并因直接实践在近似并列组内优先展示', () => {
  const scores: CompetencyScore[] = [
    'language_region', 'cross_cultural', 'game_product', 'content_storytelling',
    'market_user_research', 'data_ai', 'project_collaboration', 'portfolio_evidence',
  ].map((id) => ({ id: id as CompetencyScore['id'], score: id === 'portfolio_evidence' ? 3 : 1.32 }));
  const answers: AnswerRecord = {
    P05: 3,
    creative: 3,
    analysis: 3,
    community: 3,
    coordination: 3,
    role_experience_tags: ['community_operations'],
    experience_market_scope: 'domestic_role_adjacent',
    portfolio_role_scope: 'target_role_simulation',
  };
  const ranked = rankRoles(scores, answers);
  const community = ranked.find((item) => item.roleId === 'community');
  assert.ok(community);
  assert.equal(community.baseDirectionFit, 41.4);
  assert.equal(community.nearTie, true);
  assert.equal(community.directPracticeEvidence, true);
  assert.equal(ranked[0].roleId, 'community');
  assert.match(community.displayOrderReason, /直接海外社区运营实践证据|直接.*实践证据/);
  assert.equal(community.directionFit, community.baseDirectionFit);
});

test('[REG-22-04] SYN-STU-08五个岗位均输出80/20贡献与可复算排序依据', () => {
  const result = generateRecommendation(demoProfiles[0].answers);
  assert.equal(result.roleMatches.length, 5);
  for (const match of result.roleMatches) {
    assert.ok(Math.abs(match.abilityContribution + match.preferenceContribution - match.baseDirectionFit) <= 0.11);
    assert.ok(match.displayOrderReason.length > 0);
    assert.equal(match.directionFit, match.baseDirectionFit);
  }
});

test('门槛状态区分未通过未截断与未通过且实际截断', () => {
  const result = generateRecommendation({
    ...demoProfiles[0].answers,
    Q10: 0,
    portfolio_role_scope: 'none',
    portfolio_authenticity: 'not_applicable',
    display_status: 'not_viewable',
  });
  const effects = result.roleMatches.flatMap((match) => match.failedGates.map((gate) => gate.effect));
  assert.ok(effects.includes('failed_limiting'));
  assert.ok(effects.every((effect) => effect === 'failed_limiting' || effect === 'failed_not_limiting'));
});

test('30项行动任务依赖均存在、无循环且无阶段倒置', () => {
  assert.equal(actionTasks.length, 30);
  assert.deepEqual(validateActionGraph(), []);
  assert.ok(actionTasks.every((task) => task.prerequisiteTaskIds.every((id) => Boolean(actionMap[id]))));
});

test('[REG-22-05] SYN-STU-05零基础路线覆盖30/90/180天、依赖闭合且工时不超限', () => {
  const plan = planActionTasks('localization', ['portfolio_evidence', 'cross_cultural', 'game_product'], ['portfolio_evidence'], 8);
  const selected = new Set(Object.values(plan.tasksByTimeframe).flat());
  assert.equal(plan.feasible, true);
  assert.ok(([30, 90, 180] as Timeframe[]).every((phase) => plan.tasksByTimeframe[phase].length > 0));
  for (const taskId of selected) {
    assert.ok(actionMap[taskId].prerequisiteTaskIds.every((id) => selected.has(id)), `${taskId}缺少前置任务`);
  }
  assert.ok(([30, 90, 180] as Timeframe[]).every((phase) => plan.phaseWeeklyHours[phase] <= 8));
});

test('[REG-22-06] SYN-STU-06各阶段串行周数不超阶段容量', () => {
  const plan = planActionTasks('community', ['portfolio_evidence', 'game_product'], ['portfolio_evidence'], 8);
  assert.equal(plan.feasible, true);
  assert.ok(([30, 90, 180] as Timeframe[]).every((phase) => plan.phaseSequentialWeeks[phase] <= phaseWeeksV22[phase]));
});

test('时间不足时明确返回冲突，不静默删除前置任务', () => {
  const plan = planActionTasks('localization', ['portfolio_evidence'], ['portfolio_evidence'], 1);
  assert.equal(plan.feasible, false);
  assert.match(plan.message, /没有可行任务链/);
});

test('[REG-22-07] CON-04与BRD-06只声明数据分析，不冒充AI协作', () => {
  for (const id of ['CON-04', 'BRD-06']) {
    const task = actionMap[id];
    assert.ok(task.competencyFocus.some((focus) => focus.component === 'data_analysis'));
    assert.ok(task.competencyFocus.every((focus) => focus.component !== 'ai_collaboration'));
    assert.doesNotMatch(task.acceptanceCriteria, /训练AI协作/);
  }
});

test('[REG-22-08] 五个岗位均带样本量与待校准状态，低样本方向仍完整返回', () => {
  const result = generateRecommendation(demoProfiles[2].answers);
  assert.equal(result.roleMatches.length, 5);
  assert.ok(result.roleMatches.every((match) => match.sampleSize > 0 && match.calibrationStatus === 'pending_practitioner_review'));
  assert.equal(result.roleMatches.find((match) => match.roleId === 'community')?.sampleSize, 1);
  assert.equal(result.roleMatches.find((match) => match.roleId === 'creator_marketing')?.sampleSize, 2);
});

test('[REG-22-01] SYN-STU-05重复提交复用同一结果，失败可重试且保存版本与hash', async () => {
  let callCount = 0;
  const result = generateRecommendation(demoProfiles[0].answers);
  const storageMap = new Map<string, string>();
  const storage = {
    getItem: (key: string) => storageMap.get(key) ?? null,
    setItem: (key: string, value: string) => { storageMap.set(key, value); },
  };
  const submit = createRecommendationSubmitter(() => { callCount += 1; return result; }, 100);
  const [first, second] = await Promise.all([submit(demoProfiles[0].answers, storage), submit(demoProfiles[0].answers, storage)]);
  assert.equal(callCount, 1);
  assert.equal(first, second);
  const meta = JSON.parse(storageMap.get(RESULT_META_KEY) ?? '{}') as { websiteVersion?: string; resultHash?: string; inputSnapshotHash?: string };
  assert.equal(meta.websiteVersion, result.modelVersion);
  assert.ok(meta.resultHash && meta.inputSnapshotHash);

  let attempts = 0;
  const retry = createRecommendationSubmitter(() => {
    attempts += 1;
    if (attempts === 1) throw new Error('test');
    return result;
  }, 100);
  await assert.rejects(retry(demoProfiles[0].answers, storage), /test/);
  await retry(demoProfiles[0].answers, storage);
  assert.equal(attempts, 2);
});

test('主问题与六个必填跟进字段分开计数并全部校验', () => {
  assert.deepEqual(missingRequiredQuestions(questionsByStep[3], { creative: 0, analysis: 0 }), ['community', 'coordination']);
  assert.deepEqual(missingConditionalAnswers(2, { P03: '英语' }), [
    'role_experience_tags', 'experience_market_scope', 'content_work_scope',
    'portfolio_role_scope', 'portfolio_authenticity', 'display_status',
  ]);
  assert.deepEqual(missingConditionalAnswers(2, { P03: '英语', ...completeFollowups }), []);
  assert.deepEqual(supplementalProgress({ P03: '英语', ...completeFollowups }), { completed: 6, total: 6 });
});

test('所选跟进选项ID来自V2.2正式配置', () => {
  const result = generateRecommendation(demoProfiles[0].answers);
  const ids = new Set([
    ...questions.flatMap((question) => question.options?.map((option) => option.id) ?? []),
    ...supplementalFields.roleExperienceTags.options.map((option) => option.id),
    ...supplementalFields.experienceMarketScope.options.map((option) => option.id),
    ...supplementalFields.contentWorkScope.options.map((option) => option.id),
    ...supplementalFields.portfolioRoleScope.options.map((option) => option.id),
    ...supplementalFields.portfolioAuthenticity.options.map((option) => option.id),
    ...supplementalFields.displayStatus.options.map((option) => option.id),
  ]);
  assert.ok(result.selectedOptionIds.length > 0);
  assert.ok(result.selectedOptionIds.every((id) => ids.has(id)));
});

test('三个公开演示画像可计算且产生不同排序', () => {
  const rankings = demoProfiles.map((profile) => generateRecommendation(profile.answers).roleMatches.map((match) => match.roleId).join(','));
  assert.ok(new Set(rankings).size >= 2);
});
