const ACTION = /^\/models\/([^/:]+):(generateContent|streamGenerateContent|countTokens)$/;
const MODEL = /^gemini-[a-z0-9][a-z0-9._-]*$/i;
const INLINE_IMAGE = /^image\/[a-z0-9][a-z0-9.+-]*$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function geminiWebRoute(url, baseURL) {
  const base = new URL(baseURL);
  if (url.origin !== base.origin) return null;
  const version = url.pathname.startsWith(`${base.pathname}beta/`) ? `${base.pathname}beta` : base.pathname;
  const actionPath = url.pathname.startsWith(`${version}/`) && ACTION.exec(url.pathname.slice(version.length));
  if (!actionPath) return null;
  const [, encodedModel, action] = actionPath;
  let model;
  try {
    model = decodeURIComponent(encodedModel);
  } catch {
    return null;
  }
  if (!MODEL.test(model)) return null;
  return {
    model, action,
    validQuery: !url.hash && (!url.search || (action === 'streamGenerateContent' && url.search === '?alt=sse')),
    target: id => `${base.origin}${version}/models/${id}:${action}${url.search}`
  };
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const foldField = key => key.toLowerCase().replaceAll('ſ', 's');

// Call this after JSON.parse succeeds. Go can merge duplicate struct fields, while
// JavaScript only sees the last one. Reject them without re-encoding tool data or schemas.
export function checkedGeminiJSON(raw, unwrapCountRequest) {
  const stack = [];
  let countRequestKey = false;
  let start, end;
  for (const match of raw.matchAll(/"[^"\\]*(?:\\.[^"\\]*)*"([ \t\r\n]*:)?|[{}[\]]/gs)) {
    const [token, colon] = match;
    if (colon) {
      const key = JSON.parse(token.slice(0, -colon.length));
      const keys = stack.at(-1);
      if (keys.has(key)) throw new Error('Duplicate JSON object key');
      keys.add(key);
      if (unwrapCountRequest && stack.length === 1 && foldField(key) === 'generatecontentrequest') {
        countRequestKey = true;
      }
    } else if (token === '{') {
      if (countRequestKey) {
        start = match.index;
        countRequestKey = false;
      }
      stack.push(new Set());
    } else if (token === '[') {
      stack.push(null);
    } else if (token === '}' || token === ']') {
      stack.pop();
      if (start !== undefined && end === undefined && stack.length === 1) end = match.index + 1;
    }
  }
  // The caller has already checked that the wrapper contains a generation object.
  return unwrapCountRequest ? raw.slice(start, end) : raw;
}

// Go accepts case variations of its struct keys but does not read protobuf's snake_case.
// Only check known protocol fields. Tool arguments, schemas and extensions are opaque.
function fields(value, label, ...protocolFields) {
  if (!object(value)) throw new Error(`${label} must be an object`);
  const result = Object.create(null);
  let unsupported;
  for (const [key, val] of Object.entries(value)) {
    const folded = foldField(key);
    const flat = folded.replaceAll('_', '');
    const field = protocolFields.find(name => name.toLowerCase() === flat);
    const name = field ?? key;
    if (Object.hasOwn(result, name)) throw new Error(`Ambiguous fields in ${label}`);
    result[name] = val;
    if (field && folded !== flat) unsupported = field;
  }
  if (unsupported) throw new Error(`Use ${unsupported} in ${label}`);
  return result;
}

function array(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function modelMatches(model, id) {
  return model === id || model === `models/${id}`;
}

function validateTools(body, opts) {
  const tools = array(body.tools, 'tools');
  const config = body.toolConfig == null ? null : fields(body.toolConfig, 'toolConfig', 'functionCallingConfig');
  const calling = config?.functionCallingConfig == null ? null :
    fields(config.functionCallingConfig, 'functionCallingConfig', 'mode', 'allowedFunctionNames');
  const configKeys = config ? Object.keys(config).length : 0;
  const disabled = configKeys === 1 && typeof calling?.mode === 'string' && calling.mode.toUpperCase() === 'NONE';
  if (!opts.allowTools && (tools.length || (configKeys && !disabled))) {
    throw new Error('Tool calls are turned off for magpie-gemini-web');
  }
  for (const tool of tools) {
    const entry = fields(tool, 'Tool entries', 'functionDeclarations');
    if (Object.keys(entry).length !== 1 || !Array.isArray(entry.functionDeclarations)) {
      throw new Error('Only functionDeclarations tools are supported');
    }
    for (const declaration of entry.functionDeclarations) {
      const { name } = fields(declaration, 'Function declarations',
        'name', 'description', 'parameters', 'parametersJsonSchema');
      if (typeof name !== 'string' || !name.trim()) throw new Error('Function declarations require a name');
    }
  }
  if (calling) {
    const { mode, allowedFunctionNames } = calling;
    if ((mode != null && typeof mode !== 'string') ||
        array(allowedFunctionNames, 'allowedFunctionNames').some(name => typeof name !== 'string' || !name.trim())) {
      throw new Error('Invalid functionCallingConfig');
    }
  }
}

function validateContent(value, opts) {
  const content = fields(value, 'Content entries', 'role', 'parts');
  for (const value of array(content.parts, 'parts')) {
    const part = fields(value, 'Content parts', 'text', 'thought', 'thoughtSignature',
      'functionCall', 'functionResponse', 'inlineData', 'fileData', 'executableCode', 'codeExecutionResult');
    if (part.text != null && typeof part.text !== 'string') throw new Error('Text parts require a text string');
    if (part.executableCode != null || part.codeExecutionResult != null) {
      throw new Error('Code execution parts are unsupported');
    }
    for (const call of [part.functionCall, part.functionResponse]) {
      if (call == null) continue;
      if (!opts.allowTools) throw new Error('Tool calls are turned off for magpie-gemini-web');
      const { name, args, parts } = fields(call, 'Function calls and responses',
        'id', 'name', 'args', 'response', 'parts');
      if (typeof name !== 'string' || !name.trim() || (args != null && !object(args))) {
        throw new Error('Invalid function call or response part');
      }
      if (array(parts, 'Function result parts').length) throw new Error('Function result attachments are unsupported');
    }
    if (part.inlineData != null || part.fileData != null) {
      if (!opts.allowImages) throw new Error('Image input is turned off for magpie-gemini-web');
      // The backend downloads fileData from its network. Keep attachments in the request.
      if (part.fileData != null) throw new Error('Use inlineData for images');
      const { mimeType, data } = fields(part.inlineData, 'inlineData', 'mimeType', 'data');
      const encoded = typeof data === 'string' ? data.replace(/[\r\n]/g, '') : '';
      if (typeof mimeType !== 'string' || !INLINE_IMAGE.test(mimeType) ||
          encoded.length % 4 !== 0 || !BASE64.test(encoded)) {
        throw new Error('inlineData must contain an image MIME type and base64 data');
      }
    }
  }
}

const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'extra_high']);

function namedEffort(value) {
  const effort = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return EFFORTS.has(effort) ? effort : undefined;
}

function nativeEffort(thinking, header) {
  const effort = namedEffort(header);
  if (effort || !thinking) return effort;
  const { thinkingLevel, thinkingBudget } = thinking;
  const level = namedEffort(thinkingLevel);
  if (level || !Number.isInteger(thinkingBudget)) return level;
  // Use Magpie's Gemini budget cutoffs. Only low/medium/high twins exist here.
  if (thinkingBudget === -1) return 'medium';
  if (thinkingBudget <= 4096) return 'low';
  return thinkingBudget <= 12000 ? 'medium' : 'high';
}

export function validateGeminiWebBody(value, route, opts, effortHeader) {
  const body = fields(value, 'Request body', 'model', 'contents', 'tools', 'toolConfig',
    'systemInstruction', 'generationConfig', 'generateContentRequest', 'safetySettings', 'cachedContent');
  if (body.model != null && !modelMatches(body.model, route.model)) {
    throw new Error('Request body model must match the URL model');
  }
  validateTools(body, opts);
  for (const content of array(body.contents, 'contents')) validateContent(content, opts);
  if (body.systemInstruction != null && typeof body.systemInstruction !== 'string') {
    validateContent(body.systemInstruction, opts);
  }
  const config = body.generationConfig == null ? null : fields(body.generationConfig, 'generationConfig',
    'thinkingConfig', 'imageConfig', 'candidateCount', 'responseModalities', 'responseMimeType',
    'responseSchema', 'responseJsonSchema', 'maxOutputTokens', 'stopSequences', 'temperature', 'topP', 'topK');
  const thinking = config?.thinkingConfig == null ? null : fields(config.thinkingConfig, 'thinkingConfig',
    'thinkingLevel', 'thinkingBudget', 'includeThoughts');
  if (config?.imageConfig != null ||
      array(config?.responseModalities, 'responseModalities').some(type => type !== 'TEXT')) {
    throw new Error('Gemini Web text models support only TEXT output');
  }
  if (route.action === 'countTokens' && body.generateContentRequest != null) {
    // The Go countTokens handler takes the generation fields at the top level.
    if (body.contents != null) throw new Error('Use either contents or generateContentRequest');
    validateGeminiWebBody(body.generateContentRequest, { ...route, action: 'generateContent' }, opts);
    return { unwrapCountRequest: true };
  }
  return { effort: route.action === 'countTokens' ? undefined : nativeEffort(thinking, effortHeader) };
}
