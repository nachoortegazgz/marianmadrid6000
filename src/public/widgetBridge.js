/*
=============================================================================
MODULE: public/widgetBridge.js
RESPONSIBILITY: Centralized postMessage transport between Velo pages and
HTML widgets or Custom Elements.
STANDARDS: G10 ASCII Strict, Velo Native Optimized, Reactive Flow.
=============================================================================
*/

import {
  MESSAGE_TYPES,
  makeTraceId,
  _safeSlugOrId,
  withTimeout
} from "public/mmUtils";

const DEFAULT_TIMEOUT_MS = 30000;

function normalizeType(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeTimeout(value, fallback = DEFAULT_TIMEOUT_MS) {
  const timeout = Number(value);

  return Number.isFinite(timeout) && timeout > 0
    ? timeout
    : fallback;
}

export function createWidgetBridge(widgetElement, options = {}) {
  const traceId = options.traceId || makeTraceId("bridge");

  const slugUrl =
    _safeSlugOrId(
      options.slugUrl || options.slug || ""
    ) || "unknown";

  const widgetIsValid =
    widgetElement &&
    typeof widgetElement.postMessage === "function" &&
    typeof widgetElement.onMessage === "function";

  if (!widgetIsValid) {
    const error = new Error(
      "Widget not found or incompatible"
    );

    console.error(
      "[widgetBridge] HTML widget is not available."
    );

    if (typeof options.onError === "function") {
      try {
        options.onError(error);
      } catch (callbackError) {
        console.error(
          "[widgetBridge] onError callback failed:",
          callbackError && callbackError.message
        );
      }
    }

    return null;
  }

  const handshakeTimeoutMs = normalizeTimeout(
    options.handshakeTimeoutMs
  );

  const contextTimeoutMs = normalizeTimeout(
    options.contextTimeoutMs
  );

  const messageTimeoutMs = normalizeTimeout(
    options.messageTimeoutMs
  );

  let contextSent = false;
  let contextPromise = null;
  let handshakeTimer = null;
  let destroyed = false;

  function reportError(error) {
    if (typeof options.onError !== "function") {
      return;
    }

    try {
      options.onError(error);
    } catch (callbackError) {
      console.error(
        "[widgetBridge] onError callback failed:",
        callbackError && callbackError.message
      );
    }
  }

  function post(type, payload = {}, messageId = null) {
    if (destroyed) {
      return false;
    }

    const normalizedType = normalizeType(type);

    if (!normalizedType) {
      return false;
    }

    const safePayload =
      payload && typeof payload === "object"
        ? payload
        : {};

    const message = {
      type: normalizedType,
      payload: {
        ...safePayload,
        traceId
      }
    };

    if (messageId) {
      message.messageId = messageId;
    }

    try {
      widgetElement.postMessage(message);
      return true;
    } catch (error) {
      console.warn(
        "[widgetBridge] postMessage failed:",
        error && error.message
      );

      reportError(error);
      return false;
    }
  }

  async function postContext() {
    if (destroyed) {
      return false;
    }

    if (contextSent) {
      return true;
    }

    if (contextPromise) {
      return contextPromise;
    }

    contextPromise = (async () => {
      try {
        const contextData =
          typeof options.onContextReady === "function"
            ? await withTimeout(
                Promise.resolve(
                  options.onContextReady()
                ),
                contextTimeoutMs,
                "widget context"
              )
            : {};

        const safeContext =
          contextData &&
          typeof contextData === "object"
            ? contextData
            : {};

        const sent = post(
          MESSAGE_TYPES.CONTEXT,
          {
            ...safeContext,
            slugUrl,
            slug: slugUrl
          }
        );

        if (!sent) {
          throw new Error(
            "Widget context could not be sent"
          );
        }

        contextSent = true;

        if (handshakeTimer) {
          clearTimeout(handshakeTimer);
          handshakeTimer = null;
        }

        return true;
      } catch (error) {
        console.error(
          "[widgetBridge] Failed to prepare context:",
          error && error.message
        );

        reportError(error);
        throw error;
      } finally {
        contextPromise = null;
      }
    })();

    return contextPromise;
  }

  function sendErrorResponse(
    requestType,
    messageId,
    error
  ) {
    const responseType =
      `${normalizeType(requestType)}_RES`;

    post(
      responseType,
      {
        status: "ERROR",
        data: null,
        error: {
          code:
            error && error.code
              ? error.code
              : "WIDGET_MESSAGE_FAILED",
          message:
            error && error.message
              ? error.message
              : "Widget message failed"
        }
      },
      messageId
    );
  }

  async function handleMessage(event) {
    if (destroyed) {
      return;
    }

    const message =
      event && event.data
        ? event.data
        : event || {};

    if (
      !message ||
      typeof message !== "object"
    ) {
      return;
    }

    const type = normalizeType(
      message.type || message.action
    );

    const messageId = message.messageId || null;

    if (!type) {
      return;
    }

    if (
      type === normalizeType(MESSAGE_TYPES.READY) ||
      type === "MM_READY"
    ) {
      post(
        MESSAGE_TYPES.READY,
        { status: "ACK" },
        messageId
      );

      try {
        await postContext();
      } catch (_) {
        return;
      }

      return;
    }

    if (
      typeof options.onWidgetMessage !== "function"
    ) {
      return;
    }

    let responseSent = false;

    function reply(
      responseType,
      responsePayload = {},
      replyMessageId = messageId
    ) {
      if (destroyed || responseSent) {
        return false;
      }

      const sent = post(
        responseType,
        responsePayload,
        replyMessageId
      );

      if (sent) {
        responseSent = true;
      }

      return sent;
    }

    try {
      await withTimeout(
        Promise.resolve(
          options.onWidgetMessage(
            message,
            reply
          )
        ),
        messageTimeoutMs,
        `widget message ${type}`
      );
    } catch (error) {
      console.error(
        "[widgetBridge] onWidgetMessage failed:",
        error && error.message
      );

      if (!responseSent) {
        sendErrorResponse(
          type,
          messageId,
          error
        );
      }

      reportError(error);
    }
  }

  handshakeTimer = setTimeout(() => {
    if (!destroyed && !contextSent) {
      const error = new Error(
        "Widget handshake timeout"
      );

      reportError(error);
    }
  }, handshakeTimeoutMs);

  try {
    widgetElement.onMessage(handleMessage);
  } catch (error) {
    if (handshakeTimer) {
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
    }

    reportError(error);
    return null;
  }

  return {
    post,
    postContext,
    getTraceId: () => traceId,
    getSlugUrl: () => slugUrl,
    isReady: () => contextSent,
    isDestroyed: () => destroyed,

    destroy: () => {
      destroyed = true;

      if (handshakeTimer) {
        clearTimeout(handshakeTimer);
        handshakeTimer = null;
      }

      contextPromise = null;
    }
  };
}