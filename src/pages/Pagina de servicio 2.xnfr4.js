/**
 * MODULE: pages/servicio-2.js
 * VERSION: v5003.1
 * STANDARDS: G10 ASCII Strict, Velo Native Optimized.
 */

import wixLocation from "wix-location";
import { getServiceBySlugOrId } from "backend/reservas.web";
import {
  MESSAGE_TYPES,
  URLS,
  makeTraceId,
  _safeTrim,
  _safeSlugOrId,
  _looksLikeGuid
} from "public/mmUtils";
import { createWidgetBridge } from "public/widgetBridge";

let bridge = null;
let resolvedService = null;

function showError(message) {
  const safeMessage = String(
    message || "No se pudo cargar el servicio."
  );

  console.error("[servicio-2] Error:", safeMessage);

  try {
    const banner = $w("#errorBanner");

    if (banner && typeof banner.text === "string") {
      banner.text = `Error: ${safeMessage}`;

      if (typeof banner.show === "function") {
        banner.show();
      }
    }
  } catch (error) {
    console.warn(
      "[servicio-2] Could not display error:",
      error && error.message
    );
  }
}

function getMessageType(message) {
  return String(
    message && (message.type || message.action) || ""
  ).trim().toUpperCase();
}

async function resolveServiceLookup() {
  const query = wixLocation.query || {};

  const candidates = [
    query.slugUrl,
    query.serviceKey,
    query.serviceId
  ];

  for (const candidate of candidates) {
    const value = _safeSlugOrId(candidate);

    if (value) {
      return value;
    }
  }

  const path = Array.isArray(wixLocation.path)
    ? wixLocation.path
    : [];

  const pathValue = _safeSlugOrId(
    path[path.length - 1] || ""
  );

  const excludedPaths = new Set([
    "servicios",
    "service",
    "servicio",
    "servicio-2"
  ]);

  return pathValue && !excludedPaths.has(pathValue)
    ? pathValue
    : null;
}

function getServiceId(service) {
  return _safeTrim(
    service && (
      service.serviceId ||
      service._id ||
      ""
    )
  );
}

function getServiceSlug(service) {
  return _safeSlugOrId(
    service && service.slugUrl || ""
  );
}

function getAddonIds(payload) {
  if (!payload || !Array.isArray(payload.addons)) {
    return [];
  }

  return Array.from(
    new Set(
      payload.addons
        .map((addon) => {
          if (addon && typeof addon === "object") {
            return addon.addonId || addon.id || "";
          }

          return addon || "";
        })
        .map((value) => _safeTrim(value))
        .filter(Boolean)
    )
  );
}

function buildBookingUrl(service, payload) {
  const base =
    URLS && URLS.CALENDARIO_2
      ? URLS.CALENDARIO_2
      : "/booking-calendar/calendario-2";

  const serviceId = getServiceId(service);
  const slugUrl = getServiceSlug(service);

  const query = [];

  if (slugUrl) {
    query.push(
      `slugUrl=${encodeURIComponent(slugUrl)}`
    );
  }

  if (serviceId) {
    query.push(
      `serviceId=${encodeURIComponent(serviceId)}`
    );
  }

  query.push("referral=servicio-2");

  const addonIds = getAddonIds(payload);

  if (addonIds.length > 0) {
    query.push(
      `addonIds=${encodeURIComponent(addonIds.join(","))}`
    );
  }

  return `${base}?${query.join("&")}`;
}

$w.onReady(async function () {
  const traceId = makeTraceId("servicio");
  const widget = $w("#htmlWidgetCustomService");

  if (
    !widget ||
    typeof widget.postMessage !== "function" ||
    typeof widget.onMessage !== "function"
  ) {
    showError("El widget del servicio no esta disponible.");
    return;
  }

  try {
    const lookupValue = await resolveServiceLookup();

    if (!lookupValue) {
      showError("No se pudo localizar el servicio en la URL.");
      return;
    }

    bridge = createWidgetBridge(widget, {
      slugUrl: lookupValue,
      traceId,

      onContextReady: async function () {
        const result = await getServiceBySlugOrId(
          lookupValue
        );

        if (
          !result ||
          result.status !== "SUCCESS" ||
          !result.data
        ) {
          throw new Error(
            result &&
            result.error &&
            result.error.message
              ? result.error.message
              : "Servicio no encontrado."
          );
        }

        const serviceId = getServiceId(result.data);

        if (!_looksLikeGuid(serviceId)) {
          throw new Error(
            "El servicio no tiene un identificador valido."
          );
        }

        resolvedService = {
          ...result.data,
          serviceId,
          slugUrl: getServiceSlug(result.data)
        };

        return resolvedService;
      },

      onWidgetMessage: async function (message) {
        const type = getMessageType(message);
        const payload = message && message.payload
          ? message.payload
          : {};

        if (!resolvedService) {
          console.warn(
            "[servicio-2] Service not ready",
            { traceId, type }
          );
          return;
        }

        if (type === MESSAGE_TYPES.BOOK) {
          wixLocation.to(
            buildBookingUrl(
              resolvedService,
              payload
            )
          );
          return;
        }

        if (type === MESSAGE_TYPES.NAV) {
          const target = _safeTrim(
            payload.target || ""
          ).toUpperCase();

          if (
            !target ||
            target === "SERVICIOS"
          ) {
            wixLocation.to(
              URLS && URLS.SERVICIOS
                ? URLS.SERVICIOS
                : "/reserva-online"
            );
          }

          return;
        }

        console.warn(
          "[servicio-2] Unsupported widget message",
          { traceId, type }
        );
      },

      onError: function (error) {
        showError(
          error && error.message
            ? error.message
            : "No se pudo cargar el servicio."
        );
      }
    });

    if (!bridge) {
      showError(
        "No se pudo inicializar el widget del servicio."
      );
    }
  } catch (error) {
    console.error(
      "[servicio-2] Initialization failed",
      {
        traceId,
        message: error && error.message
      }
    );

    showError(
      error && error.message
        ? error.message
        : "No se pudo cargar el servicio."
    );
  }
});