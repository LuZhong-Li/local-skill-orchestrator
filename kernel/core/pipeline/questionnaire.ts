/** 需求追问状态机。 */

import type {
  Problem,
  Question,
  Questionnaire,
  QuestionnaireState,
  DecisionRecord,
} from './types.ts';

/**
 * 创建初始问卷。
 */
export function createQuestionnaire(problem: Problem, maxRounds = 3): Questionnaire {
  const questions: Question[] = [
    { id: 'q1', text: '这个问题要解决谁的痛点？', required: true },
    { id: 'q2', text: '成功标准是什么？', required: true },
    { id: 'q3', text: '有哪些硬约束？', required: true },
    { id: 'q4', text: '有没有相关的参考或竞品？', required: false },
  ];

  return {
    problemId: problem.id,
    state: 'asking',
    rounds: 1,
    maxRounds,
    questions,
  };
}

/**
 * 记录问题答案。
 */
export function recordAnswer(q: Questionnaire, questionId: string, answer: string): Questionnaire {
  const newQuestions = q.questions.map((question) =>
    question.id === questionId ? { ...question, answer } : question,
  );

  let newState: QuestionnaireState = q.state;
  if (newState === 'asking') {
    const allRequiredAnswered = newQuestions
      .filter((x) => x.required)
      .every((x) => x.answer !== undefined);
    if (allRequiredAnswered) {
      newState = 'converged';
    }
  }

  return {
    ...q,
    questions: newQuestions,
    state: newState,
  };
}

/**
 * 判断是否已收敛。
 */
export function isConverged(q: Questionnaire): boolean {
  return q.state === 'converged' || q.state === 'max_rounds_reached';
}

/**
 * 进入下一轮。
 */
export function nextRound(q: Questionnaire): Questionnaire {
  if (isConverged(q)) {
    return q;
  }

  const newRounds = q.rounds + 1;
  let newState: QuestionnaireState = 'asking';

  if (newRounds > q.maxRounds) {
    newState = 'max_rounds_reached';
  }

  return {
    ...q,
    rounds: newRounds,
    state: newState,
  };
}

/**
 * 获取还未回答的必填问题。
 */
export function getOpenQuestions(q: Questionnaire): Question[] {
  return q.questions.filter((x) => x.required && x.answer === undefined);
}

/**
 * 构建决策记录。
 */
export function buildDecisionRecords(q: Questionnaire): DecisionRecord[] {
  return q.questions
    .filter((x) => x.answer !== undefined)
    .map((x) => ({
      questionId: x.id,
      question: x.text,
      answer: x.answer!,
      rationale: '基于用户回答',
    }));
}
