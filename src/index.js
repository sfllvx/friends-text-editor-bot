
const MODES = {
  natural: {
    title: "Natural",
    description: "Естественна дать",
    instruction: "Edit for natural, fluent language. Preserve the author's meaning, level of English, and personal writing style. Avoid clichés and unnecessary rewriting."
  },
  academic: {
    title: "Academic",
    description: "По академски",
    instruction: "Edit into clear academic prose suitable for a university assignment. Improve precision and logical flow without unnecessarily complex vocabulary. Preserve arguments, limitations, citations, quotations, and references. Do not invent sources or evidence."
  },
  professional: {
    title: "Professional",
    description: "Деловой дракон",
    instruction: "Edit into clear, concise professional writing. Preserve the author's intent, factual details, and natural tone."
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
    await sendMessage(
      env,
      chatId,
      "Братан, у тебя нет доступа, попроси владельца внести твой айди."
    );
    return;
  }

  const text = (message.text || "").trim();

  if (!text) {
    await sendMessage(
      env,
      chatId,
      "Пока я обрабатываю только текстовые сообщения. Отправь текст прямо в чат."
    );
    return;
  }

  if (text === "/start" || text.startsWith("/start ")) {
    await sendMessage(
      env,
      chatId,
      "Салам Аллейкум! Я редактор текстов на русском и английском. Выбери стиль, затем отправь текст.\n\nЯ помогаю улучшать ясность и естественность текста, но не гарантирую результат конкретного AI-детектора.",
      modeKeyboard()
    );
    return;
  }

  if (text === "/help") {
    await sendMessage(
      env,
      chatId,
      "/start — меню\n/mode — выбрать стиль\n/usage — посмотреть дневной лимит\n/privacy — информация об обработке данных\n\nОтправь текст до 10 000 символов."
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
      "Текст отправляется в Google Gemini API для обработки. Для лимитов хранится счётчик использования за день и выбранный режим. Не отправляй пароли или конфиденциальную информацию."
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
      `Текст слишком длинный (${text.length} символов). Максимум — ${MAX_INPUT_CHARS} символов.`
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
      `Дневной лимит достигнут: ${DAILY_REQUEST_LIMIT} запросов и ${DAILY_CHAR_LIMIT} символов. Попробуй завтра.`,
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

    await sendMessage(
      env,
      chatId,
      "Выбери стиль для следующего текста:",
      modeKeyboard()
    );
  } catch (error) {
    console.error("Rewrite failed:", error?.message || String(error));

    const messageText = error?.name === "AbortError"
      ? "Запрос к Gemini превысил лимит ожидания. Попробуй ещё раз позже."
      : "Не удалось обработать текст. Проверь Cloudflare Logs. Запрос не был засчитан.";

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
  if (!env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY");
  }

  const systemInstruction = `You are a professional editor and expert in deep text rewriting.

Editing style: ${MODES[mode].instruction}

Your goal is to rewrite the provided text so it reads naturally, flows smoothly, and retains the author's individual voice.

1. SENTENCE RHYTHM AND STRUCTURE
- Vary sentence length and structure according to the meaning.
- Combine concise statements with longer, more developed explanations where appropriate.
- Avoid repetitive sentence patterns and monotonous paragraph structures.
- Do not force short sentences into the text when they interrupt the natural flow.

2. REMOVE CLICHÉS AND FORMULAIC LANGUAGE
- Avoid generic phrases such as "In today's fast-paced world", "It is important to note", "Furthermore", "Moreover", "In conclusion", and "A key aspect to consider" when they add no meaningful information.
- Avoid unnecessary transitions and filler.
- Do not summarise the same point at the end of every paragraph.
- Let each paragraph develop its own argument naturally.

3. SYNTAX AND VOICE
- Prefer active voice when it makes the sentence clearer.
- Use precise verbs and concrete explanations.
- Avoid repeating the same words or using parallel sentence structures in adjacent sentences.
- Preserve passive voice when it is appropriate to the subject or academic context.

4. TONE AND VOCABULARY
- Adapt the tone to the selected editing style and intended audience.
- Prefer clear, familiar vocabulary over unnecessarily sophisticated synonyms.
- Preserve the author's original level of English and individual writing habits.
- Avoid excessively polished, generic, or robotic-sounding prose.
- Do not change wording merely to make it look different.
- Make substantial changes only when they improve clarity, flow, or precision.

5. ACCURACY AND MEANING
- Preserve the original meaning, facts, figures, examples, and logical relationships.
- Do not invent evidence, statistics, references, or personal experiences.
- Preserve citations, quotations, names, and dates.
- Do not deliberately introduce errors or change factual claims.

6. FINAL REVIEW
- Check that the text reads clearly and naturally.
- Remove unnecessary repetition and generic phrasing.
- Ensure that the selected editing style is consistent throughout.
- Keep useful original wording when it already works well.

OUTPUT FORMAT
Return only the final edited text.
Do not include introductions, explanations, commentary, or editing notes.`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 45000);

  try {
    const response = await fetch(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.OPENAI_API_KEY}`
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: "gpt-6.1-sol",
          instructions: systemInstruction,
          input: text,
          reasoning: { effort: "medium" },
          max_output_tokens: 4000
        })
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        `OpenAI API ${response.status}: ${
          data?.error?.message || "Request failed"
        }`
      );
    }

    const output = (data.output || [])
      .filter(item => item.type === "message")
      .flatMap(item => item.content || [])
      .filter(item => item.type === "output_text")
      .map(item => item.text || "")
      .join("")
      .trim();

    if (!output) {
      throw new Error("OpenAI returned no text");
    }

    return output;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("OpenAI request timed out after 45 seconds");
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
