import { mergeMessagesById, mergeDiscussionMessagesById, applyReadEvent, applyReadEvents, removePendingByClientMessageId, markPendingMessageFailed, markPendingMessageSending } from '../../utils/messageState';

test('history 응답이 늦게 도착해도 동일 chatId 메시지는 중복되지 않는다', () => {
  // WS로 먼저 도착한 메시지가 READ_EVENT로 갱신된 상태
  const prev = [{ chatId: 4, content: 'ws-msg', unreadMemberCount: 3 }];
  // 이후 도착한 history 응답 — chatId 4가 stale 값(5)으로 중복 포함
  const incoming = [
    { chatId: 1, content: 'A', unreadMemberCount: 0 },
    { chatId: 2, content: 'B', unreadMemberCount: 0 },
    { chatId: 3, content: 'C', unreadMemberCount: 0 },
    { chatId: 4, content: 'ws-msg', unreadMemberCount: 5 },
  ];

  const result = mergeMessagesById(prev, incoming);

  expect(result).toHaveLength(4);
  expect(result.map((m) => m.chatId)).toEqual([1, 2, 3, 4]);
  // prev 우선 — READ_EVENT로 갱신된 값(3)이 stale history 값(5)에 덮이지 않는다
  expect(result[3].unreadMemberCount).toBe(3);
});

test('WS로 먼저 수신된 메시지는 늦게 도착한 history 응답에 의해 유실되지 않는다', () => {
  // history가 먼저 도착해 set된 상태
  const afterHistory = mergeMessagesById([], [
    { chatId: 1, content: 'A' },
    { chatId: 2, content: 'B' },
  ]);

  // 이후 WS 신규 메시지 도착
  const result = mergeMessagesById(afterHistory, [{ chatId: 3, content: 'C' }]);

  expect(result).toHaveLength(3);
  expect(result.map((m) => m.chatId)).toEqual([1, 2, 3]);
  expect(result[2].content).toBe('C');
});

test('메시지 병합 결과는 chatId 오름차순을 유지한다', () => {
  const prev = [{ chatId: 5 }, { chatId: 3 }];
  const incoming = [{ chatId: 1 }, { chatId: 4 }, { chatId: 2 }];

  const result = mergeMessagesById(prev, incoming);

  expect(result.map((m) => m.chatId)).toEqual([1, 2, 3, 4, 5]);
});

test('Discussion sync 응답이 늦게 도착해도 WS 메시지는 유실되지 않는다', () => {
  // WS로 먼저 도착한 Discussion 메시지
  const prev = [{ discussionMessageId: 4, content: 'ws-discussion' }];
  // 이후 도착한 sync 응답 — id 4 미포함 (fetch 시점 이후 저장됨)
  const incoming = [
    { discussionMessageId: 1 },
    { discussionMessageId: 2 },
    { discussionMessageId: 3 },
  ];

  const result = mergeDiscussionMessagesById(prev, incoming);

  expect(result).toHaveLength(4);
  expect(result.map((m) => m.discussionMessageId)).toEqual([1, 2, 3, 4]);
  // prev 우선 — WS로 받은 메시지가 유지된다
  expect(result[3].content).toBe('ws-discussion');
});

test('동일 discussionMessageId 메시지는 중복 병합되지 않는다', () => {
  const prev = [{ discussionMessageId: 1 }, { discussionMessageId: 2 }];
  // sync 응답이 동일한 id를 포함
  const incoming = [{ discussionMessageId: 1 }, { discussionMessageId: 2 }];

  const result = mergeDiscussionMessagesById(prev, incoming);

  expect(result).toHaveLength(2);
  expect(result.map((m) => m.discussionMessageId)).toEqual([1, 2]);
});

test('Discussion 메시지 병합 결과는 discussionMessageId 오름차순을 유지한다', () => {
  const prev = [{ discussionMessageId: 5 }, { discussionMessageId: 3 }];
  const incoming = [
    { discussionMessageId: 1 },
    { discussionMessageId: 4 },
    { discussionMessageId: 2 },
  ];

  const result = mergeDiscussionMessagesById(prev, incoming);

  expect(result.map((m) => m.discussionMessageId)).toEqual([1, 2, 3, 4, 5]);
});

// ── applyReadEvent ─────────────────────────────────────────────────────────

test('READ_EVENT 범위에 포함된 메시지만 unreadMemberCount가 감소한다', () => {
  const messages = [
    { chatId: 1, senderId: 99, unreadMemberCount: 3 },
    { chatId: 2, senderId: 99, unreadMemberCount: 3 },
    { chatId: 3, senderId: 99, unreadMemberCount: 3 },
    { chatId: 4, senderId: 99, unreadMemberCount: 3 },
  ];
  const readEvent = {
    memberId: 42,
    previousLastReadChatId: 2,
    currentLastReadChatId: 3,
  };

  const result = applyReadEvent(messages, readEvent);

  // chatId 1, 2: 범위 밖 → 변화 없음
  expect(result[0].unreadMemberCount).toBe(3);
  expect(result[1].unreadMemberCount).toBe(3);
  // chatId 3: 범위 안 (2 < 3 <= 3) → 감소
  expect(result[2].unreadMemberCount).toBe(2);
  // chatId 4: 범위 밖 (4 > 3) → 변화 없음
  expect(result[3].unreadMemberCount).toBe(3);
});

test('READ_EVENT를 발생시킨 사용자의 메시지는 unreadMemberCount가 감소하지 않는다', () => {
  const messages = [
    { chatId: 1, senderId: 42, unreadMemberCount: 3 }, // 이벤트 발생자 본인 메시지
    { chatId: 2, senderId: 99, unreadMemberCount: 3 }, // 다른 멤버 메시지
  ];
  const readEvent = {
    memberId: 42,
    previousLastReadChatId: null,
    currentLastReadChatId: 2,
  };

  const result = applyReadEvent(messages, readEvent);

  // 본인 메시지 → 감소하지 않음
  expect(result[0].unreadMemberCount).toBe(3);
  // 다른 멤버 메시지 → 감소
  expect(result[1].unreadMemberCount).toBe(2);
});

test('unreadMemberCount는 0 아래로 내려가지 않는다', () => {
  const messages = [
    { chatId: 1, senderId: 99, unreadMemberCount: 0 },
  ];
  const readEvent = {
    memberId: 42,
    previousLastReadChatId: null,
    currentLastReadChatId: 1,
  };

  const result = applyReadEvent(messages, readEvent);

  expect(result[0].unreadMemberCount).toBe(0);
});

test('READ_EVENT로_갱신된_prev는_뒤늦게_도착한_stale_REST_응답에_의해_롤백되지_않는다', () => {
  const base = [{ chatId: 4, senderId: 99, unreadMemberCount: 3 }];
  const readEvent = {
    memberId: 42,
    previousLastReadChatId: null,
    currentLastReadChatId: 4,
  };

  const prev = applyReadEvent(base, readEvent);

  const incoming = [{ chatId: 4, senderId: 99, unreadMemberCount: 3 }];

  const result = mergeMessagesById(prev, incoming);

  expect(result).toHaveLength(1);
  expect(result[0].chatId).toBe(4);
  expect(result[0].unreadMemberCount).toBe(2);
});

// ── applyReadEvents (READ_EVENT_BATCH) ──────────────────────────────────────

test('readEvents가 비어 있으면 messages를 그대로(같은 참조로) 반환한다', () => {
  const messages = [{ chatId: 1, senderId: 99, unreadMemberCount: 3 }];

  const result = applyReadEvents(messages, []);

  expect(result).toBe(messages);
});

test('batch의 여러 read item이 한 번의 순회로 모두 반영된다', () => {
  const messages = [
    { chatId: 1, senderId: 99, unreadMemberCount: 2 },
    { chatId: 2, senderId: 99, unreadMemberCount: 2 },
  ];
  const readEvents = [
    { memberId: 10, previousLastReadChatId: null, currentLastReadChatId: 1 },
    { memberId: 11, previousLastReadChatId: 1, currentLastReadChatId: 2 },
  ];

  const result = applyReadEvents(messages, readEvents);

  // chatId 1: member 10만 읽음 범위에 포함 → 1감소
  expect(result[0].unreadMemberCount).toBe(1);
  // chatId 2: member 11만 읽음 범위에 포함 → 1감소
  expect(result[1].unreadMemberCount).toBe(1);
});

test('applyReadEvent를 배열로 반복 적용한 결과와 applyReadEvents의 결과는 동일하다', () => {
  const messages = [
    { chatId: 1, senderId: 99, unreadMemberCount: 3 },
    { chatId: 2, senderId: 99, unreadMemberCount: 3 },
    { chatId: 3, senderId: 99, unreadMemberCount: 3 },
  ];
  const readEvents = [
    { memberId: 10, previousLastReadChatId: null, currentLastReadChatId: 2 },
    { memberId: 11, previousLastReadChatId: 1, currentLastReadChatId: 3 },
  ];

  const sequential = readEvents.reduce((acc, e) => applyReadEvent(acc, e), messages);
  const batched = applyReadEvents(messages, readEvents);

  expect(batched).toEqual(sequential);
});

test('unreadMemberCount는 batch 적용 후에도 0 아래로 내려가지 않는다', () => {
  const messages = [{ chatId: 1, senderId: 99, unreadMemberCount: 0 }];
  const readEvents = [
    { memberId: 10, previousLastReadChatId: null, currentLastReadChatId: 1 },
    { memberId: 11, previousLastReadChatId: null, currentLastReadChatId: 1 },
  ];

  const result = applyReadEvents(messages, readEvents);

  expect(result[0].unreadMemberCount).toBe(0);
});

// ── removePendingByClientMessageId ──────────────────────────────────────────

test('일치하는 clientMessageId를 가진 pending 항목이 제거된다', () => {
  const pendingMessages = [
    { clientMessageId: 'uuid-1', message: 'hello', status: 'sending' },
    { clientMessageId: 'uuid-2', message: 'world', status: 'sending' },
  ];

  const result = removePendingByClientMessageId(pendingMessages, 'uuid-1');

  expect(result).toHaveLength(1);
  expect(result[0].clientMessageId).toBe('uuid-2');
});

test('일치하는 clientMessageId가 없으면 pendingMessages가 그대로 유지된다', () => {
  const pendingMessages = [
    { clientMessageId: 'uuid-1', message: 'hello', status: 'sending' },
  ];

  const result = removePendingByClientMessageId(pendingMessages, 'uuid-999');

  expect(result).toEqual(pendingMessages);
});

test('clientMessageId가 null 또는 undefined면 pendingMessages를 그대로 반환한다', () => {
  const pendingMessages = [
    { clientMessageId: 'uuid-1', message: 'hello', status: 'sending' },
  ];

  expect(removePendingByClientMessageId(pendingMessages, null)).toBe(pendingMessages);
  expect(removePendingByClientMessageId(pendingMessages, undefined)).toBe(pendingMessages);
});

test('같은 clientMessageId로 반복 호출해도 안전하다 (idempotent)', () => {
  const pendingMessages = [
    { clientMessageId: 'uuid-1', message: 'hello', status: 'sending' },
    { clientMessageId: 'uuid-2', message: 'world', status: 'sending' },
  ];

  const once = removePendingByClientMessageId(pendingMessages, 'uuid-1');
  const twice = removePendingByClientMessageId(once, 'uuid-1');

  expect(once).toHaveLength(1);
  expect(twice).toHaveLength(1);
  expect(twice[0].clientMessageId).toBe('uuid-2');
});

// ── markPendingMessageFailed ────────────────────────────────────────────────

test('일치하는 clientMessageId의 sending 상태가 failed로 변경된다', () => {
  const pendingMessages = [
    { clientMessageId: 'uuid-1', message: 'hello', status: 'sending' },
    { clientMessageId: 'uuid-2', message: 'world', status: 'sending' },
  ];

  const result = markPendingMessageFailed(pendingMessages, 'uuid-1');

  expect(result[0].status).toBe('failed');
  expect(result[1].status).toBe('sending');
});

test('일치하는 clientMessageId가 없으면 변화 없다', () => {
  const pendingMessages = [
    { clientMessageId: 'uuid-1', message: 'hello', status: 'sending' },
  ];

  const result = markPendingMessageFailed(pendingMessages, 'uuid-999');

  expect(result).toEqual(pendingMessages);
});

test('이미 failed인 항목은 다시 호출해도 변하지 않는다 (idempotent)', () => {
  const pendingMessages = [
    { clientMessageId: 'uuid-1', message: 'hello', status: 'failed' },
  ];

  const result = markPendingMessageFailed(pendingMessages, 'uuid-1');

  expect(result[0].status).toBe('failed');
  expect(result).toEqual(pendingMessages);
});

test('failed로 변경되어도 다른 필드는 보존된다', () => {
  const pendingMessages = [
    {
      clientMessageId: 'uuid-1',
      message: 'hello',
      status: 'sending',
      senderId: 42,
      senderNickname: 'me',
      isTemporary: true,
    },
  ];

  const result = markPendingMessageFailed(pendingMessages, 'uuid-1');

  expect(result[0]).toEqual({
    clientMessageId: 'uuid-1',
    message: 'hello',
    status: 'failed',
    senderId: 42,
    senderNickname: 'me',
    isTemporary: true,
  });
});

test('failed 상태의 pending도 removePendingByClientMessageId로 제거할 수 있다', () => {
  const pendingMessages = [
    { clientMessageId: 'uuid-1', message: 'hello', status: 'failed' },
    { clientMessageId: 'uuid-2', message: 'world', status: 'sending' },
  ];

  const result = removePendingByClientMessageId(pendingMessages, 'uuid-1');

  expect(result).toHaveLength(1);
  expect(result[0].clientMessageId).toBe('uuid-2');
});

// ── markPendingMessageSending ──────────────────────────────────────────────

test('일치하는 clientMessageId의 failed 상태가 sending으로 변경된다', () => {
  const pendingMessages = [
    { clientMessageId: 'uuid-1', message: 'hello', status: 'failed' },
    { clientMessageId: 'uuid-2', message: 'world', status: 'sending' },
  ];

  const result = markPendingMessageSending(pendingMessages, 'uuid-1');

  expect(result[0].status).toBe('sending');
  expect(result[1].status).toBe('sending');
});

test('일치하는 clientMessageId가 없으면 sending으로 변화 없다', () => {
  const pendingMessages = [
    { clientMessageId: 'uuid-1', message: 'hello', status: 'failed' },
  ];

  const result = markPendingMessageSending(pendingMessages, 'uuid-999');

  expect(result).toEqual(pendingMessages);
});

test('이미 sending인 항목은 다시 호출해도 변하지 않는다 (idempotent)', () => {
  const pendingMessages = [
    { clientMessageId: 'uuid-1', message: 'hello', status: 'sending' },
  ];

  const result = markPendingMessageSending(pendingMessages, 'uuid-1');

  expect(result[0].status).toBe('sending');
  expect(result).toEqual(pendingMessages);
});

test('sending으로 변경되어도 다른 필드는 보존된다', () => {
  const pendingMessages = [
    {
      clientMessageId: 'uuid-1',
      message: 'hello',
      status: 'failed',
      senderId: 42,
      senderNickname: 'me',
      isTemporary: true,
    },
  ];

  const result = markPendingMessageSending(pendingMessages, 'uuid-1');

  expect(result[0]).toEqual({
    clientMessageId: 'uuid-1',
    message: 'hello',
    status: 'sending',
    senderId: 42,
    senderNickname: 'me',
    isTemporary: true,
  });
});
