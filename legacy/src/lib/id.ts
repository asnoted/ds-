let counter = 0;

/** 生成一条单调递增的消息 id,前缀由调用方给(install / send / ack ...). */
export function nextMessageId(prefix = "msg"): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

/** 测试用:把计数器归零,让 id 序列可断言. */
export function resetMessageIds(): void {
  counter = 0;
}
