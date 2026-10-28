
const MODES = {
  natural: {
    title: "Natural",
    description: "Естественная редактура",
    instruction: "Edit for natural, fluent language. Vary sentence structure where appropriate, remove clichés and awkward phrasing, and preserve the author's meaning and level of certainty. Do not add unsupported claims."
  },
  academic: {
    title: "Academic",
    description: "Академический стиль",
    instruction: "Edit into clear, credible academic prose appropriate for a university assignment. Improve precision, logical flow, and formality without making the text needlessly complicated. Preserve the author's argument, limitations, citations, quotations, and references. Do not invent sources or evidence."
  },
  professional: {
    title: "Professional",
    description: "Деловой стиль",
    instruction: "Edit into concise, polished professional writing. Improve clarity, tone, structure, and readability while preserving the author's intent and factual details."
  }
};

const DAILY_REQUEST_LIMIT = 10;
const DAILY_CHAR_LIMIT = 20000;
const MAX_INPUT_CHARS = 10000;
const TELEGRAM_MESSAGE_LIMIT = 3900;
const GEMINI_TIMEOUT_MS = 45000;

export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      return new Response("Telegram text editor is running.", { status: 200 });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const expectedSecret = env.TELEGRAM_WEBHOOK_SECRET;
    const receivedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");

    if (!expectedSecret || receivedSecret !== expectedSecret) {
      return new Response("Unauthorized", { status: 401 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    try {
      if (update.message) await handleMessage(update.message, env);
      if (update.callback_query) await handleCallback(update.callback_query, env);
    } catch (error) {
      console.error("Update handling failed:", error?.message || String(error));
    }

    return new Response("OK");
  }
};

async function handleMessage(message, env) {
  const chatId = message.chat?.id;
  const userId = message.from?.id;

  if (!chatId || !userId) return;

  if (!isAllowed(userId, env)) {
    await sendMessage(env, chatId, "Этот бот закрытый. Попроси владельца добавить твой Telegram ID в список доступа.");
    return;
  }

  const text = (message.text || "").trim();

  if (!text) {
    await sendMessage(env, chatId, "Пока я обрабатываю только текстовые сообщения. Отправь текст прямо в чат.");
    return;
  }

  if (text === "/start" || text.startsWith("/start ")) {
    await sendMessage(
      env,
      chatId,
      "Привет! Я редактор текстов на русском и английском. Выбери стиль, затем отправь текст.\n\nЯ улучшаю естественность и ясность, но не могу гарантировать результат конкретного ИИ-детектора.",
      modeKeyboard()
    );
    return;
  }

  if (text === "/help") {
    await sendMessage(
      env,
      chatId,
      "/start — меню\n/mode — выбрать стиль\n/usage — посмотреть дневной лимит\n/privacy — как обрабатываются данные\n\nОтправь текст до 10 000 символов для редактирования."
    );
    return;
  }

  if (text === "/mode") {
    await sendMessage(env, chatId, "Выбери стиль редактирования:", modeKeyboard());
    return;
  }

  if (text === "/privacy") {
    await sendMessage(
      env,
      chatId,
      "Текст не сохраняется ботом в базе данных. Для лимитов хранится только счётчик использования за день и выбранный режим. Текст отправляется в Google Gemini API для обработки, поэтому не отправляй пароли, финансовые данные или другую конфиденциальную информацию. Проверь актуальные условия обработки данных Google перед использованием."
    );
    return;
  }

  if (text === "/usage") {
    const usage = await getUsage(userId, env);
    await sendMessage(
      env,
      chatId,
      `Сегодня использовано: ${usage.requests}/${DAILY_REQUEST_LIMIT} запросов и ${usage.chars}/${DAILY_CHAR_LIMIT} символов.`
    );
    return;
  }

  if (text.startsWith("/")) {
    await sendMessage(env, chatId, "Неизвестная команда. Используй /help.");
    return;
  }

  if (text.length > MAX_INPUT_CHARS) {
    await sendMessage(
      env,
      chatId,
      `Текст слишком длинный (${text.length} символов). Максимум — ${MAX_INPUT_CHARS} символов за один запрос.`
    );
    return;
  }

  const usage = await getUsage(userId, env);

  if (
    usage.requests >= DAILY_REQUEST_LIMIT ||
    usage.chars + text.length > DAILY_CHAR_LIMIT
  ) {
    await sendMessage(
      env,
      chatId,
      `Дневной бесплатный лимит достигнут. Лимит: ${DAILY_REQUEST_LIMIT} запросов и ${DAILY_CHAR_LIMIT} символов в день. Попробуй завтра.`,
      modeKeyboard()
    );
    return;
  }

  const mode = await getMode(userId, env);
  await sendChatAction(env, chatId, "typing");

  try {
    const edited = await rewriteText(text, mode, env);

    await saveUsage(
      userId,
      usage.requests + 1,
      usage.chars + text.length,
      env
    );

    await sendLongMessage(
      env,
      chatId,
      `Готово · ${MODES[mode].title}\n\n${edited}`
    );
  } catch (error) {
    console.error("Rewrite failed:", error?.message || String(error));

    const messageText = error?.name === "AbortError"
      ? "Запрос к Gemini превысил лимит ожидания. Попробуй ещё раз позже."
      : "Не удалось обработать текст. Проверь Cloudflare Logs для подробностей. Запрос не был засчитан.";

    await sendMessage(env, chatId, messageText);
  }
}

async function handleCallback(query, env) {
  const userId = query.from?.id;
  const chatId = query.message?.chat?.id;
  const data = query.data || "";

  if (!userId || !chatId) return;

  if (!isAllowed(userId, env)) {
    await answerCallback(env, query.id, "Нет доступа.");
    return;
  }

  if (data.startsWith("mode:")) {
    const mode = data.slice(5);

    if (!MODES[mode]) {
      await answerCallback(env, query.id, "Неизвестный режим.");
      return;
    }

    await env.USER_DATA.put(
      modeKey(userId),
      mode,
      { expirationTtl: 60 * 60 * 24 * 90 }
    );

    await answerCallback(env, query.id, `Выбран режим ${MODES[mode].title}`);

    await sendMessage(
      env,
      chatId,
      `Выбран режим: ${MODES[mode].title} — ${MODES[mode].description}. Теперь отправь текст.`
    );
  }
}

function isAllowed(userId, env) {
  const ids = (env.ALLOWED_TELEGRAM_IDS || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);

  return ids.includes(String(userId));
}

function modeKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🌿 Natural", callback_data: "mode:natural" }],
      [{ text: "🎓 Academic", callback_data: "mode:academic" }],
      [{ text: "💼 Professional", callback_data: "mode:professional" }]
    ]
  };
}

function modeKey(userId) {
  return `mode:${userId}`;
}

function usageKey(userId) {
  return `usage:${new Date().toISOString().slice(0, 10)}:${userId}`;
}

async function getMode(userId, env) {
  const saved = await env.USER_DATA.get(modeKey(userId));
  return MODES[saved] ? saved : "natural";
}

async function getUsage(userId, env) {
  const raw = await env.USER_DATA.get(usageKey(userId));

  if (!raw) return { requests: 0, chars: 0 };

  try {
    const parsed = JSON.parse(raw);

    return {
      requests: Number(parsed.requests) || 0,
      chars: Number(parsed.chars) || 0
    };
  } catch {
    return { requests: 0, chars: 0 };
  }
}

async function saveUsage(userId, requests, chars, env) {
  await env.USER_DATA.put(
    usageKey(userId),
    JSON.stringify({ requests, chars }),
    { expirationTtl: 60 * 60 * 48 }
  );
}

async function rewriteText(text, mode, env) {
  if (!env.GEMINI_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY");
  }

 
  const model = env.GEMINI_MODEL || "gemini-3.5-flash-lite";

  const systemInstruction = `You are a careful text editor working in the selected style.

Editing style: ${MODES[mode].instruction}

Follow these rules:
- Preserve the user's original meaning, arguments, facts, evidence, and personal voice.
- Use clear, precise, natural language appropriate for the intended audience.
- Avoid generic openings, clichés, formulaic transitions, and unnecessary filler.
- Vary sentence structure naturally without making the writing artificially casual.
- For academic writing, maintain an appropriate formal tone without unnecessarily complicated vocabulary.
- Preserve technical terminology, citations, quotations, references, names, numbers, and dates.
- Do not invent examples, statistics, sources, evidence, or personal experiences.
- Do not introduce deliberate grammar mistakes or awkward wording.
- Make only the changes needed to improve clarity, fluency, and readability.
- Return only the edited text, without explanations or commentary.`;

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    GEMINI_TIMEOUT_MS
  );

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemInstruction }]
          },
          contents: [
            { role: "user", parts: [{ text }] }
          ],
          generationConfig: {
            maxOutputTokens: 4000,
            thinkingConfig: {
              thinkingLevel: "low"
            }
          }
        })
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message =
        data?.error?.message || `Gemini API error ${response.status}`;

      throw new Error(`Gemini API ${response.status}: ${message}`);
    }

    const output = (data?.candidates?.[0]?.content?.parts || [])
      .map(part => part.text || "")
      .join("")
      .trim();

    if (!output) {
      const reason =
        data?.promptFeedback?.blockReason ||
        data?.candidates?.[0]?.finishReason ||
        "unknown";

      throw new Error(`Empty model response (${reason})`);
    }

    return output;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Gemini request timed out after 45 seconds");
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function telegramCall(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }
  );

  const result = await response.json().catch(() => ({}));

  if (!response.ok || result.ok === false) {
    throw new Error(
      result.description || `Telegram API error ${response.status}`
    );
  }

  return result;
}

async function sendMessage(env, chatId, text, replyMarkup) {
  return telegramCall(env, "sendMessage", {
    chat_id: chatId,
    text: text.slice(0, TELEGRAM_MESSAGE_LIMIT),
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });
}

async function sendLongMessage(env, chatId, text) {
  const chunks = splitText(text, TELEGRAM_MESSAGE_LIMIT);

  for (const chunk of chunks) {
    await sendMessage(env, chatId, chunk);
  }
}

function splitText(text, limit) {
  const chunks = [];
  let rest = text;

  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);

    if (cut < limit * 0.5) {
      cut = rest.lastIndexOf(" ", limit);
    }

    if (cut < limit * 0.5) {
      cut = limit;
    }

    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }

  if (rest) chunks.push(rest);

  return chunks;
}

async function sendChatAction(env, chatId, action) {
  try {
    await telegramCall(env, "sendChatAction", {
      chat_id: chatId,
      action
    });
  } catch {
    // Non-critical.
  }
}

async function answerCallback(env, callbackQueryId, text) {
  try {
    await telegramCall(env, "answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text
    });
  } catch {
    // Non-critical.
  }
}
