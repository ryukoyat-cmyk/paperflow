export const FULL_REVIEW_MAX_CHARS = 300_000;
export const MAX_BODY_CHARS = 1_000_000;

export function getDocumentPolicy(bodyChars) {
  if (!Number.isFinite(bodyChars) || bodyChars < 0) throw new TypeError('본문 글자 수가 올바르지 않습니다.');
  if (bodyChars > MAX_BODY_CHARS) {
    return { allowed: false, review: false, mode: 'rejected', bodyChars };
  }
  const review = bodyChars <= FULL_REVIEW_MAX_CHARS;
  return { allowed: true, review, mode: review ? 'reviewed' : 'draft-only', bodyChars };
}
