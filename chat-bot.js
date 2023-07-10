// 利用するGPTモデルを設定してください
const gptModel = "gpt-3.5-turbo";

// アシスタントの振る舞いを設定してください（空でもOK）
const character = ``;

// ========================
// ここからは修正必要ありません
// ========================

const BOT_MEMBER_ID =
  PropertiesService.getScriptProperties().getProperty("BOT_MEMBER_ID");
const BOT_CHANNEL_ID =
  PropertiesService.getScriptProperties().getProperty("BOT_CHANNEL_ID");
const BOT_AUTH_TOKEN =
  PropertiesService.getScriptProperties().getProperty("BOT_AUTH_TOKEN");
const OPENAI_SECRET_KEY =
  PropertiesService.getScriptProperties().getProperty("OPENAI_SECRET_KEY");

const fetchMsgsInThread = (channelId, threadTimestamp) => {
  const url = `https://slack.com/api/conversations.replies?channel=${channelId}&ts=${threadTimestamp}`;

  const headers = {
    "Content-Type": "application/json",
    Authorization: "Bearer " + BOT_AUTH_TOKEN,
  };

  const options = {
    method: "GET",
    headers,
  };

  const response = UrlFetchApp.fetch(url, options);
  const data = JSON.parse(response.getContentText());

  if (data.ok) {
    return data.messages;
  } else {
    throw new Error(`Failed to fetch messages in thread: ${data.error}`);
  }
};

/**
 * botに問いかけられたメッセージを取得する
 * @param {object} triggerMsg - Slackからのトリガーとなるメッセージ
 * @param {string} triggerMsg.channel - トリガーとなったメッセージが送信されたチャンネルID
 * @param {string} triggerMsg.text - トリガーとなったメッセージのテキスト
 * @param {string} [triggerMsg.thread_ts] - トリガーとなったメッセージが属するスレッドのタイムスタンプ（省略可）
 * @returns {object[]} - botに問いかけられたメッセージの配列。該当するものが無い場合は空配列を返す
 */
const fetchSlackMsgsAskedToBot = (triggerMsg) => {
  const isInThread = triggerMsg.thread_ts;
  const isMenthionedBot = triggerMsg.text.includes(BOT_MEMBER_ID);

  if (!isInThread) {
    // スレッド外の場合
    if (triggerMsg.channel === BOT_CHANNEL_ID || isMenthionedBot) {
      // botとのDMの場合か、botへのメンションがある場合は応答
      return [triggerMsg];
    } else {
      // それ以外の場合は無視
      return [];
    }
  } else {
    // スレッド内の場合
    const isMentionedNonBot =
      !isMenthionedBot && triggerMsg.text.includes("<@");
    if (isMentionedNonBot) {
      // bot以外へのメンションがある場合は無視
      return [];
    } else {
      // botへの問いかけと思われるスレッドの場合、スレッド内のすべてのメッセージを取得する
      const msgsInThread = fetchMsgsInThread(
        triggerMsg.channel,
        triggerMsg.thread_ts
      );

      const isBotInvolvedThread =
        msgsInThread.find((msg) => msg.user === BOT_MEMBER_ID) == null;
      if (isBotInvolvedThread && !isMenthionedBot) {
        // botと無関係のスレッドの場合は無視
        return [];
      } else {
        // botへの問いかけと思われるスレッド内のメッセージをすべて返す
        return msgsInThread;
      }
    }
  }
};

/**
 * メンションされたテキストから、メンション部分を除去して返す
 * @param {string} source - メンションされたテキスト
 * @returns {string} メンション部分が除去されたテキスト
 */
const trimMentionText = (source) => {
  const regex = /^<.+> /;
  return source.replace(regex, "").trim();
};

/**
 * SlackのメッセージをChatGPTのクエリメッセージ形式に変換する
 * @param {object[]} slackMsgs - Slackのメッセージオブジェクト群
 * @param {string} slackMsgs[].user - ユーザーID
 * @param {string} slackMsgs[].text - メッセージのテキスト
 * @returns {object[]} ChatGPTのクエリメッセージオブジェクト群
 */
const parseSlackMsgsToChatGPTQuesryMsgs = (slackMsgs) => {
  // 配列の各要素を変換
  return slackMsgs.map((msg) => {
    // BOT_MEMBER_IDと比較して、送信者がユーザーかアシスタントかを判断（TODO: 必要？）
    const role = msg.user == BOT_MEMBER_ID ? "assistant" : "user";
    // メンション部分を除去したテキストを取得
    const content = trimMentionText(msg.text);
    // 送信者の役割とテキストを含むメッセージオブジェクトを返す
    return {
      role: role,
      content: content,
    };
  });
};

/**
 * AIからの応答を取得する関数
 * @param {string} tiggerMsg - ユーザーの入力メッセージ
 * @returns {string} - 応答メッセージ
 */
const fetchAIAnswerText = (tiggerMsg) => {
  // Botに問い合わせられたメッセージを取得する
  const msgsAskedToBot = fetchSlackMsgsAskedToBot(tiggerMsg);
  // Botに問い合わせられたメッセージが無かった場合は空文字を返す
  if (msgsAskedToBot.length === 0) return "";
  // 取得したメッセージをChat GPT用に変換する
  const msgsForChatGpt = parseSlackMsgsToChatGPTQuesryMsgs(msgsAskedToBot);
  // OpenAIへのエンドポイントとAPIキーを設定する
  const ENDPOINT = "https://api.openai.com/v1/chat/completions";
  // リクエストボディを作成する
  const requestBody = {
    model: gptModel,
    messages: [{ role: "system", content: character }, ...msgsForChatGpt],
    temperature: 0.5,
  };

  try {
    // OpenAIへPOSTリクエストを送信する
    const res = UrlFetchApp.fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + OPENAI_SECRET_KEY,
        Accept: "application/json",
      },
      contentType: "application/json",
      payload: JSON.stringify(requestBody),
    });

    // ステータスコードが200以外の場合はエラーメッセージを返す
    const resCode = res.getResponseCode();
    if (resCode !== 200) {
      if (resCode === 429) return "利用上限に達しました";
      else return "APIリクエストに失敗しました";
    }

    // レスポンスからAIから返された回答を取得する
    const resPayloadObj = JSON.parse(res.getContentText());
    if (resPayloadObj.choices.length === 0) return "AIからの応答が空でした";

    // 取得した回答を整形して返す
    const rawAnswerText = resPayloadObj.choices[0].message.content;
    const trimedAnswerText = rawAnswerText.replace(/^\n+/, "");
    return trimedAnswerText;
  } catch (e) {
    // エラー発生時はエラーメッセージを返す
    console.error(e.stack);
    return `エラーが発生しました ${e.stack}`;
  }
};

/**
 * Slackの指定したチャンネルにメッセージを投稿する
 * @param {string} channelId - 投稿先のチャンネルID
 * @param {string} message - 投稿するメッセージのテキスト
 * @param {object} option - オプションパラメータ（省略可）
 * @param {string} option.thread_ts - スレッドタイムスタンプ
 * @param {('default'|'primary'|'danger')} option.color - テキスト部分の色
 * @param {boolean} option.link_names - メンションの展開状態を設定
 * @returns {void}
 */
const slackPostMessage = (channelId, message, option) => {
  const url = "https://slack.com/api/chat.postMessage";

  const headers = {
    "Content-Type": "application/json",
    Authorization: "Bearer " + BOT_AUTH_TOKEN,
  };

  // メッセージデータ
  const payload = {
    channel: channelId,
    text: message,
    ...option,
  };

  // HTTPリクエストを作成
  const options = {
    method: "POST",
    headers,
    payload: JSON.stringify(payload),
  };

  // Slack APIにリクエストを送信
  UrlFetchApp.fetch(url, options);
};

/**
 * doPost関数は、SlackアプリからのPOSTリクエストを処理します。
 * @returns {void}
 */
const doPost = (e) => {
  const reqObj = JSON.parse(e.postData.getDataAsString());

  // Slackから認証コードが送られてきた場合(初回接続時)
  if (reqObj.type == "url_verification") {
    // 認証コードをそのまま返すことで、アプリをSlackに登録する処理が完了する
    return ContentService.createTextOutput(reqObj.challenge);
  }

  // Slackからのコールバック以外の場合、OKを返して処理を終了する
  if (reqObj.type !== "event_callback" || reqObj.event.type !== "message") {
    return ContentService.createTextOutput("OK");
  }

  // メッセージが編集または削除された場合、OKを返して処理を終了する
  if (reqObj.event.subtype !== undefined) {
    return ContentService.createTextOutput("OK");
  }

  // Slackから送信されたトリガーメッセージ
  const triggerMsg = reqObj.event;
  // ユーザーID
  const userId = triggerMsg.user;
  // メッセージID
  const msgId = triggerMsg.client_msg_id;
  // チャンネルID
  const channelId = triggerMsg.channel;
  // タイムスタンプ
  const ts = triggerMsg.ts;

  // Bot自身によるメッセージである場合、OKを返して処理を終了する
  if (userId === BOT_MEMBER_ID) {
    return ContentService.createTextOutput("OK");
  }

  // 処理したメッセージのIDをキャッシュして、同じメッセージを無視する
  const isCachedId = (id) => {
    const cache = CacheService.getScriptCache();
    const isCached = cache.get(id);
    // キャッシュされたIDである場合、trueを返す
    if (isCached) return true;
    // IDをキャッシュに追加する
    cache.put(id, true, 60 * 5); // 5分間キャッシュする
    return false;
  };

  // 処理済みのメッセージの場合、OKを返して処理を終了する
  if (isCachedId(msgId)) {
    return ContentService.createTextOutput("OK");
  }

  try {
    // 応答メッセージを取得する
    const answerMsg = fetchAIAnswerText(triggerMsg);
    // 応答メッセージが存在しない場合、OKを返して処理を終了する
    if (!answerMsg) return ContentService.createTextOutput("OK");
    // Slackに応答メッセージを投稿する
    slackPostMessage(channelId, answerMsg, { thread_ts: ts });
    return ContentService.createTextOutput("OK");
  } catch (e) {
    console.error(e.stack, "応答エラーが発生");
    // エラーが発生した場合、NGを返して処理を終了する
    return ContentService.createTextOutput("NG");
  }
};
