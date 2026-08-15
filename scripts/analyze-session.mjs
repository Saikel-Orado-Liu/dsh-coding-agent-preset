#!/usr/bin/env node
/**
 * Analyze a DSH exported session.jsonl using the same trajectory lexicon
 * fingerprint as dsh-router-standard/probe/analyze-session.mjs.
 *
 * Counts:
 *   - reasoningBlocks: distinct turn:step groups reconstructed from reasoning-chunks
 *   - we / lets / letMe / i: lexical counts across reconstructed reasoning text
 *   - markerFirstLine: number of reasoning blocks whose first line is good/great/excellent
 *   - visibleReplies: assistant messages containing a text block
 *
 * Usage:
 *   node scripts/analyze-session.mjs <session.jsonl>
 *
 * Example:
 *   node scripts/analyze-session.mjs "D:/Projects/_pro-test1/session.jsonl"
 */
import { readFileSync } from 'node:fs'

function count(text, regex) {
  return [...text.matchAll(regex)].length
}

/**
 * Conservative trajectory lexicon classifier.
 * Logic mirrors xiaobright/modeltest evaluator/trigger_probe/src/classifier.mjs
 * (MIT), extended with first-token histogram and let's counting.
 */
function classifyReasoning(reasoning) {
  const text = (reasoning || '').trim()
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  const firstToken = firstLine.trim().split(/\s+/, 1)[0] ?? ''
  return {
    chars: text.length,
    we: count(text, /\bwe\b/gi),
    letMe: count(text, /\blet me\b/gi),
    lets: count(text, /\blet's\b/gi),
    i: count(text, /\bi\b/gi),
    firstToken,
    markerFirstLine: /^(good|great|excellent)\.?$/i.test(firstLine.trim()),
  }
}

const path = process.argv[2]
if (!path) {
  console.error('usage: node scripts/analyze-session.mjs <session.jsonl>')
  process.exit(1)
}

const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean)
const events = lines.map((line) => JSON.parse(line))

const reasoningByMessage = new Map()
const messageOrder = []
for (const event of events) {
  if (event.type !== 'reasoning-chunks') continue
  const data = event.data ?? {}
  const key = `t${data.turn ?? '?'}:s${data.step ?? '?'}`
  if (!reasoningByMessage.has(key)) {
    reasoningByMessage.set(key, [])
    messageOrder.push(key)
  }
  reasoningByMessage.get(key).push(...(Array.isArray(data.texts) ? data.texts : []))
}

let we = 0
let lets = 0
let letMe = 0
let i = 0
let markerFirstLine = 0
let reasoningChars = 0
for (const key of messageOrder) {
  const full = reasoningByMessage.get(key).join('')
  const metrics = classifyReasoning(full)
  we += metrics.we
  lets += metrics.lets
  letMe += metrics.letMe
  i += metrics.i
  markerFirstLine += metrics.markerFirstLine ? 1 : 0
  reasoningChars += metrics.chars
}

const toolCalls = events.filter((event) => event.type === 'tool/call')
const toolBreakdown = {}
for (const event of toolCalls) {
  const name = event.data?.name ?? event.data?.tool ?? '?'
  toolBreakdown[name] = (toolBreakdown[name] || 0) + 1
}

const visibleReplies = events.filter((event) =>
  event.type === 'assistant/message' &&
  (event.data?.message?.content ?? []).some((part) => part.type === 'text'),
).length

const header = events.find((event) => event.type === 'request/header')
const selected = events.find((event) => event.type === 'agent-preset/selected')
const userMessage = events.find((event) => event.type === 'user/message')
const headerTools = (header?.data?.header?.tools ?? header?.data?.tools ?? []).map((tool) =>
  typeof tool === 'string' ? tool : tool.name,
)

const times = events
  .map((event) => event.time ?? event.createdAt)
  .filter((value) => typeof value === 'number')
const firstTime = times.length > 0 ? Math.min(...times) : undefined
const lastTime = times.length > 0 ? Math.max(...times) : undefined

const output = {
  session: path.split(/[\\/]/).pop(),
  preset: selected?.data?.agentPreset ?? null,
  model: header?.data?.header?.config?.model ?? null,
  reasoningEffort: header?.data?.header?.config?.reasoningEffort ?? null,
  prompt: userMessage?.data?.content?.[0]?.text ?? null,
  headerTools,
  reasoningBlocks: messageOrder.length,
  we,
  lets,
  letMe,
  i,
  markerFirstLine,
  reasoningChars,
  visibleReplies,
  steps: events.filter((event) => event.type === 'step/start').length,
  toolCalls: toolCalls.length,
  toolBreakdown,
  durationMs: firstTime !== undefined && lastTime !== undefined ? lastTime - firstTime : null,
}

console.log(JSON.stringify(output, null, 2))
