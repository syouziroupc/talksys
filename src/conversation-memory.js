export const SESSION_STORE_MAX_MESSAGES = 80;
export const SESSION_CONTEXT_MAX_MESSAGES = 28;
export const CALLER_MEMORY_MAX_MESSAGES = 20;
export const MEMORY_MESSAGE_MAX_CHARS = 1000;

function cleanContent(value) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MEMORY_MESSAGE_MAX_CHARS);
}

export function compactConversation(messages, limit = SESSION_STORE_MAX_MESSAGES) {
  const max = Math.max(1, Number(limit) || SESSION_STORE_MAX_MESSAGES);
  return (Array.isArray(messages) ? messages : [])
    .filter((item) => item && (item.role === 'user' || item.role === 'assistant'))
    .map((item) => ({ role: item.role, content: cleanContent(item.content) }))
    .filter((item) => item.content)
    .slice(-max);
}

export function contextWindow(messages, limit = SESSION_CONTEXT_MAX_MESSAGES) {
  return compactConversation(messages, limit);
}

export function normalizeCallerIdentity(value) {
  let raw = String(value || '').normalize('NFKC').trim();
  if (!raw) return '';
  raw = raw.replace(/^tel:/i, '');
  if (/^[+＋\d\s().-]+$/.test(raw)) {
    raw = raw.replace(/＋/g, '+').replace(/[\s().-]+/g, '');
    if (raw.startsWith('00')) raw = `+${raw.slice(2)}`;
    if (!/^\+?\d{7,18}$/.test(raw)) return '';
    return `tel:${raw}`.slice(0, 80);
  }
  const safe = raw.toLowerCase().replace(/[^a-z0-9_.:@+-]/g, '').slice(0, 120);
  return safe.length >= 6 ? `id:${safe}` : '';
}

export function trustedCallerIdentity(connection) {
  const state = connection?.state || {};
  const trusted = state?.talksysTrustedCaller;
  if (!trusted || trusted.trusted !== true) return '';
  return normalizeCallerIdentity(trusted.identity);
}

function sessionObject(connection) {
  const value = connection?.state?.talksysSession;
  return value && typeof value === 'object' ? value : null;
}

export function getSession(connection) {
  const session = sessionObject(connection);
  if (!session) return null;
  return {
    id: String(session.id || ''),
    activeCall: session.activeCall === true,
    callerKey: normalizeCallerIdentity(session.callerKey || ''),
    startedAt: Number(session.startedAt) || 0,
    messages: compactConversation(session.messages),
  };
}

function writeSession(connection, session) {
  if (!connection?.setState) return null;
  const prior = connection.state && typeof connection.state === 'object' ? connection.state : {};
  const next = session ? {
    id: String(session.id || ''),
    activeCall: session.activeCall === true,
    callerKey: normalizeCallerIdentity(session.callerKey || ''),
    startedAt: Number(session.startedAt) || Date.now(),
    messages: compactConversation(session.messages),
  } : null;
  connection.setState({ ...prior, talksysSession: next });
  return next;
}

function newSessionId(connection) {
  const connectionId = String(connection?.id || '').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 80);
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `call:${connectionId || 'connection'}:${random}`.slice(0, 180);
}

export function beginCallSession(connection, seedMessages = []) {
  const callerKey = trustedCallerIdentity(connection);
  return writeSession(connection, {
    id: newSessionId(connection),
    activeCall: true,
    callerKey,
    startedAt: Date.now(),
    messages: compactConversation(seedMessages),
  });
}

export function ensureConnectionSession(connection) {
  const existing = getSession(connection);
  if (existing) return existing;
  return writeSession(connection, {
    id: newSessionId(connection),
    activeCall: false,
    callerKey: trustedCallerIdentity(connection),
    startedAt: Date.now(),
    messages: [],
  });
}

export function getConversationHistory(connection) {
  const session = getSession(connection);
  return contextWindow(session?.messages || []);
}

export function appendConversationTurn(connection, userText, assistantText) {
  const session = ensureConnectionSession(connection);
  if (!session) return [];
  const messages = [...session.messages];
  const user = cleanContent(userText);
  const assistant = cleanContent(assistantText);

  // User input is recorded as soon as a turn begins so a follow-up arriving while
  // the previous answer/search is still running can resolve phrases such as
  // "どうですか" against that in-flight question. When the answer later completes,
  // avoid duplicating the already-recorded user message.
  const last = messages.at(-1);
  if (user && !(last?.role === 'user' && last.content === user)) {
    messages.push({ role: 'user', content: user });
  }
  if (assistant) messages.push({ role: 'assistant', content: assistant });

  const next = writeSession(connection, { ...session, messages });
  return contextWindow(next?.messages || []);
}

export function recordConversationUser(connection, userText) {
  return appendConversationTurn(connection, userText, '');
}

export function endCallSession(connection) {
  const session = getSession(connection);
  writeSession(connection, null);
  return session;
}

export function callerMemorySlice(messages) {
  return compactConversation(messages, CALLER_MEMORY_MAX_MESSAGES);
}

export function setTrustedCallerIdentity(connection, identity) {
  const callerKey = normalizeCallerIdentity(identity);
  if (!callerKey || !connection?.setState) return '';
  const prior = connection.state && typeof connection.state === 'object' ? connection.state : {};
  connection.setState({
    ...prior,
    talksysTrustedCaller: { trusted: true, identity: callerKey },
  });
  return callerKey;
}
