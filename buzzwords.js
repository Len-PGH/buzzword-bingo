'use strict';
/*
 * Buzzword Bingo — the word pools.
 *
 * POSITIVE = buzzwords worth celebrating (genuinely good engineering, security,
 *            and responsible-AI practices).
 * NEGATIVE = groan-worthy, overused, or hype-y buzzwords (corporate + AI hype).
 *
 * Each word a player blots is tagged with its polarity, which drives:
 *   - the card's composition % (positive vs negative words on the card), and
 *   - the live "buzz sentiment" % (of the words blotted so far, how positive).
 *
 * Edit freely. Keep both lists comfortably larger than a card (>= 24 each) so
 * every card can be filled without borrowing across polarities.
 */

const POSITIVE = [
  // Engineering & platform
  'open source', 'open weights', 'self-hosted', 'on-device inference',
  'local-first', 'interoperable', 'standards-based', 'accessible',
  'well-documented', 'backwards-compatible', 'low-latency', 'resilient',
  'fault-tolerant', 'horizontally scalable', 'zero-downtime', 'idempotent',
  'composable', 'event-driven', 'real-time', 'streaming', 'battle-tested',
  'reproducible', 'graceful degradation', 'sane defaults', 'first principles',
  'feature flags', 'canary deploy', 'infrastructure as code', 'observability',
  'distributed tracing',
  // Security & privacy
  'end-to-end encrypted', 'privacy-first', 'least privilege', 'sandboxed',
  'rate-limited', 'zero trust', 'audit log',
  // Responsible AI
  'human-in-the-loop', 'guardrails', 'evals', 'grounded responses',
  'structured output', 'tool use', 'model card', 'data provenance',
  'opt-in', 'red-teamed', 'small models', 'quantized', 'deterministic output',
];

const NEGATIVE = [
  // Corporate cringe
  'synergy', 'leverage', 'paradigm shift', 'disrupt', 'thought leader',
  'growth hacking', 'ninja', 'rockstar', 'move the needle', 'boil the ocean',
  'circle back', 'low-hanging fruit', 'drink the kool-aid',
  'single pane of glass', 'digital transformation', 'north star',
  'double-click on that', 'ecosystem play', 'quantum leap', 'game changer',
  'table stakes', 'unlock value', 'best-of-breed', 'turnkey', 'at scale',
  // Tech hype
  'web3', 'blockchain', 'metaverse', 'hyperscale', 'next-gen', 'seamless',
  'frictionless', 'bleeding edge', 'cutting edge', 'cloud-native',
  'serverless', 'revolutionary', 'supercharge', 'future-proof', 'webscale',
  // AI hype
  'AI-powered', 'AI-native', 'agentic', 'AGI', 'GenAI', 'LLM-powered',
  'GPT-powered', 'sprinkle some AI', 'AI wrapper', 'autonomous agents',
  'hallucination-free', '10x engineer', 'prompt engineering', 'the AI just knows',
  'AI copilot for everything',
];

// AI company + model name-drops. These are POLARITY-NEUTRAL: they fill cells and
// can be blotted, but don't count toward the positive-vs-negative buzz sentiment
// (name-dropping is orthogonal to good/bad buzz). Model names date fast — edit away.
const NAMES = [
  // Companies / platforms
  'OpenAI', 'Anthropic', 'Google DeepMind', 'Meta AI', 'Mistral AI', 'xAI',
  'Cohere', 'Hugging Face', 'Stability AI', 'Perplexity', 'NVIDIA',
  'Databricks', 'Amazon Bedrock', 'Azure OpenAI', 'Groq', 'Together AI',
  'Replicate', 'DeepSeek', 'Alibaba Qwen', 'Runway',
  // Models
  'GPT-4o', 'GPT-5', 'o3', 'Claude', 'Claude Opus', 'Claude Sonnet',
  'Gemini', 'Gemini 2.5', 'Llama 3', 'Llama 4', 'Mistral Large', 'Mixtral',
  'Phi-3', 'Command R', 'Grok', 'DeepSeek-R1', 'Qwen', 'Stable Diffusion',
  'Whisper', 'Sora', 'Flux', 'Nova',
];

module.exports = { POSITIVE, NEGATIVE, NAMES };
