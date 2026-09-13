/*
=============================================================================
MODULE: backend/bookingServiceSync.js
VERSION: v5005-3
FIXES APPLIED:
[BS-01] item.buffer is the canonical buffer field.
[BS-02] BOOKINGS_SERVICE_SYNC_QUEUE is the only queue collection.
[BS-03] Removed unused imports and variables.
[BS-04] Stable payload hashing and idempotent queue records.
[BS-05] Safe retry and exponential backoff handling.
[BS-06] Internal queue updates do not overwrite system fields.
STANDARDS: G10 ASCII Strict.
=============================================================================
*/

import wixData from "wix-data";
import { elevate } from "wix-auth";
import { services } from "wix-bookings.v2";

import {
  makeTraceId,
  _looksLikeGuid,
  _safeTrim,
  _extractRelationalId
} from "public/mmUtils";

import { hashSHA256 } from "backend/securityEngine";
import { logger } from "backend/booking/bookingCore";
import {
  COLLECTIONS,
  SDK_CONFIG,
  SERVICE_CATALOG
} from "backend/internalConfig";

const log = logger;

const QUEUE_COL =
  COLLECTIONS.BOOKINGS_SERVICE_SYNC_QUEUE;

const MAX_ATTEMPTS =
  Number(
    SDK_CONFIG?.JOBS
      ?.BOOKINGS_SERVICE_SYNC_MAX_ATTEMPTS
  ) || 5;

const BATCH_SIZE =
  Number(
    SDK_CONFIG?.JOBS
      ?.BOOKINGS_SERVICE_SYNC_BATCH_SIZE
  ) || 20;

const BACKOFF_MS =
  Number(
    SDK_CONFIG?.JOBS
      ?.BOOKINGS_SERVICE_SYNC_BACKOFF_MS
  ) || 300000;

const VALID_STATUS = [
  "PENDING",
  "RETRY"
];

const DEFAULT_CATEGORY_ID =
  "c97726db-84aa-4a08-b34e-7fda9e17702e";

const getServiceElevated =
  elevate(services.getService);

const updateServiceElevated =
  elevate(services.updateService);

function _cleanText(value, maxLength) {
  const text = String(value ?? "").trim();

  if (text.length > maxLength) {
    throw new Error("SYNC_TEXT_TOO_LONG");
  }

  return text;
}

function _cleanGuid(value, errorCode) {
  const guid = _extractRelationalId(value);

  if (!_looksLikeGuid(guid)) {
    throw new Error(errorCode);
  }

  return guid;
}

function _cleanGuidList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map((entry) =>
          _extractRelationalId(entry)
        )
        .filter((id) =>
          _looksLikeGuid(id)
        )
    )
  );
}

function _parseStaffIds(rawStaff) {
  if (Array.isArray(rawStaff)) {
    return rawStaff;
  }

  if (typeof rawStaff !== "string") {
    return [];
  }

  if (!rawStaff.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawStaff);

    if (
      parsed &&
      Array.isArray(parsed.staffIds)
    ) {
      return parsed.staffIds;
    }

    return Array.isArray(parsed)
      ? parsed
      : [];
  } catch (_) {
    return [];
  }
}

function _buildDesiredProjection(item) {
  if (!item || typeof item !== "object") {
    throw new Error("SYNC_ITEM_INVALID");
  }

  const title = _cleanText(
    item.title || item.name,
    160
  );

  if (!title) {
    throw new Error("SYNC_TITLE_REQUIRED");
  }

  const duration = Number(
    item.totalDuration
  );

  const price = Number(item.price);

  const safeDuration =
    Number.isFinite(duration) &&
    duration >= 0
      ? duration
      : 0;

  const safePrice =
    Number.isFinite(price) &&
    price >= 0
      ? price
      : 0;

  const currency =
    _safeTrim(item.currency) ||
    SERVICE_CATALOG.CURRENCY ||
    "EUR";

  const isHidden =
    item.hidden === true;

  const isActive =
    item.active === true ||
    _safeTrim(item.status)
      .toUpperCase() === "ACTIVO";

  const staffIds =
    _cleanGuidList(
      _parseStaffIds(
        item.availableStaff
      )
    );

  const categoryId = _cleanGuid(
    item.categoryId ||
      DEFAULT_CATEGORY_ID,
    "SYNC_CATEGORY_INVALID"
  );

  const description =
    _cleanText(
      item.description || "",
      6000
    );

  const tagLine =
    _cleanText(
      item.tagLine || "",
      120
    );

  const buffer = Number(item.buffer);

  const safeBuffer =
    Number.isFinite(buffer) &&
    buffer >= 0
      ? buffer
      : 0;

  return {
    service: {
      name: title,
      description,
      tagLine,
      categoryId,
      status: isActive
        ? "CREATED"
        : "DRAFT",
      hidden: isHidden,
      paymentOptions: {
        wixPayOnline:
          item.onlinePayment !== false,
        wixPayInPerson:
          item.inPersonPayment !== false
      },
      schedule: {
        durationInMinutes:
          safeDuration,
        bufferTimeInMinutes:
          safeBuffer
      },
      rate: {
        labeledPriceOptions: {
          general: {
            amount: String(safePrice),
            currency
          }
        }
      }
    },
    staffIds
  };
}

function _buildQueueRecord(
  serviceId,
  desiredPayload,
  previous = null
) {
  const payloadHash =
    hashSHA256(
      JSON.stringify(desiredPayload)
    );

  return {
    _id: `SYNC_${serviceId}`,
    serviceId,
    desiredPayload,
    payloadHash,
    status: "PENDING",
    attempts: Number(
      previous?.attempts || 0
    ),
    nextAttemptAt: new Date(),
    lastError: null,
    completedAt: null,
    _createdDate:
      previous?._createdDate ||
      new Date()
  };
}

function _stripSystemFields(item) {
  if (!item || typeof item !== "object") {
    return {};
  }

  const {
    _createdDate,
    _updatedDate,
    _owner,
    _deleted,
    ...safeItem
  } = item;

  return safeItem;
}

function _getRetryDate(attempts) {
  const exponent = Math.max(
    0,
    Number(attempts) - 1
  );

  const delay =
    BACKOFF_MS *
    Math.pow(2, exponent);

  return new Date(
    Date.now() + delay
  );
}

export async function enqueueBookingsServiceSync(
  serviceItem
) {
  if (
    !serviceItem ||
    typeof serviceItem !== "object"
  ) {
    return null;
  }

  const serviceId =
    _extractRelationalId(
      serviceItem.serviceId ||
      serviceItem._id
    );

  if (!_looksLikeGuid(serviceId)) {
    return null;
  }

  const desiredPayload =
    _buildDesiredProjection(
      serviceItem
    );

  const existing =
    await wixData
      .get(
        QUEUE_COL,
        `SYNC_${serviceId}`,
        {
          suppressAuth: true
        }
      )
      .catch(() => null);

  const queueRecord =
    _buildQueueRecord(
      serviceId,
      desiredPayload,
      existing
    );

  return wixData.save(
    QUEUE_COL,
    queueRecord,
    {
      suppressAuth: true
    }
  );
}

async function _updateQueueItem(
  item,
  fields
) {
  const safeItem =
    _stripSystemFields(item);

  return wixData.update(
    QUEUE_COL,
    {
      ...safeItem,
      ...fields,
      _updatedDate: new Date()
    },
    {
      suppressAuth: true
    }
  );
}

async function _syncQueueItem(
  item,
  traceId
) {
  const serviceId =
    _cleanGuid(
      item?.serviceId,
      "SYNC_SERVICE_INVALID"
    );

  const desired =
    item?.desiredPayload?.service;

  if (!desired) {
    throw new Error(
      "SYNC_PAYLOAD_MISSING"
    );
  }

  const current =
    await getServiceElevated(
      serviceId
    );

  if (!current?.service) {
    throw new Error(
      "BOOKING_SERVICE_NOT_FOUND"
    );
  }

  const patch = {
    name: desired.name,
    description: desired.description,
    tagLine: desired.tagLine,
    categoryId: desired.categoryId,
    status: desired.status,
    hidden: desired.hidden,
    paymentOptions:
      desired.paymentOptions,
    schedule: desired.schedule,
    rate: desired.rate
  };

  await updateServiceElevated(
    serviceId,
    patch
  );

  await _updateQueueItem(
    item,
    {
      status: "COMPLETED",
      completedAt: new Date(),
      lastError: null
    }
  );

  log.info(
    "Bookings service synchronized",
    {
      traceId,
      serviceId
    }
  );
}

export async function processBookingsServiceSyncQueue(
  options = {}
) {
  const traceId =
    options.traceId ||
    makeTraceId(
      "cron-bookings-sync"
    );

  const now = new Date();

  const pending =
    await wixData
      .query(QUEUE_COL)
      .hasSome(
        "status",
        VALID_STATUS
      )
      .le(
        "nextAttemptAt",
        now
      )
      .ascending(
        "nextAttemptAt"
      )
      .limit(BATCH_SIZE)
      .find({
        suppressAuth: true,
        consistentRead: true
      });

  let completed = 0;
  let failed = 0;

  for (
    const item of pending?.items || []
  ) {
    try {
      await _syncQueueItem(
        item,
        traceId
      );

      completed += 1;
    } catch (error) {
      const attempts =
        Number(item?.attempts || 0) + 1;

      const isTerminal =
        attempts >= MAX_ATTEMPTS;

      await _updateQueueItem(
        item,
        {
          status: isTerminal
            ? "FAILED"
            : "RETRY",
          attempts,
          lastError:
            _cleanText(
              error?.message ||
                "SYNC_ERROR",
              500
            ),
          nextAttemptAt:
            isTerminal
              ? null
              : _getRetryDate(
                  attempts
                )
        }
      ).catch((updateError) => {
        log.error(
          "Bookings sync queue update failed",
          {
            traceId,
            serviceId: item?.serviceId,
            message:
              updateError?.message
          }
        );
      });

      log.error(
        "Bookings service synchronization failed",
        {
          traceId,
          serviceId: item?.serviceId,
          attempts,
          terminal: isTerminal,
          message: error?.message
        }
      );

      failed += 1;
    }
  }

  return {
    status: "SUCCESS",
    data: {
      scanned:
        pending?.items?.length || 0,
      completed,
      failed
    },
    error: null
  };
}
