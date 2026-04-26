/**
 * Unit tests for the Xero webhook signature verifier and persistence layer.
 *
 * Signature verifier is pure — exercised directly. Persistence and processing
 * are mocked at the prisma + xero boundary.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

// --- Mocks ---------------------------------------------------------------

const eventFindFirstMock = vi.fn();
const eventCreateMock = vi.fn();
const eventFindUniqueMock = vi.fn();
const eventUpdateMock = vi.fn();
const customerFindFirstMock = vi.fn();

vi.mock('@joho-erp/database', () => ({
  prisma: {
    xeroWebhookEvent: {
      findFirst: (...args: unknown[]) => eventFindFirstMock(...args),
      create: (...args: unknown[]) => eventCreateMock(...args),
      findUnique: (...args: unknown[]) => eventFindUniqueMock(...args),
      update: (...args: unknown[]) => eventUpdateMock(...args),
    },
    customer: {
      findFirst: (...args: unknown[]) => customerFindFirstMock(...args),
    },
  },
}));

const fetchInvoiceContactIdMock = vi.fn();
const getStoredTokensMock = vi.fn();
vi.mock('../xero', () => ({
  fetchInvoiceContactId: (...args: unknown[]) => fetchInvoiceContactIdMock(...args),
  getStoredTokens: (...args: unknown[]) => getStoredTokensMock(...args),
}));

const enqueueXeroJobMock = vi.fn();
vi.mock('../xero-queue', () => ({
  enqueueXeroJob: (...args: unknown[]) => enqueueXeroJobMock(...args),
}));

vi.mock('../../utils/logger', () => ({
  xeroLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  verifyXeroWebhookSignature,
  persistXeroWebhookEvents,
  processPersistedWebhookEvent,
} from '../xero-webhook';

// --- Helpers -------------------------------------------------------------

const SIGNING_KEY = 'test-signing-key-1234567890';

function sign(body: string, key: string = SIGNING_KEY): string {
  return crypto.createHmac('sha256', key).update(body, 'utf8').digest('base64');
}

// --- Tests ---------------------------------------------------------------

describe('verifyXeroWebhookSignature', () => {
  it('returns true for a correctly signed body', () => {
    const body = JSON.stringify({ events: [], firstEventSequence: 1 });
    const sig = sign(body);
    expect(verifyXeroWebhookSignature(body, sig, SIGNING_KEY)).toBe(true);
  });

  it('returns false when signature is wrong', () => {
    const body = JSON.stringify({ events: [] });
    const wrongSig = sign('different body');
    expect(verifyXeroWebhookSignature(body, wrongSig, SIGNING_KEY)).toBe(false);
  });

  it('returns false when signature is missing', () => {
    expect(verifyXeroWebhookSignature('{}', null, SIGNING_KEY)).toBe(false);
  });

  it('returns false when signing key is missing', () => {
    expect(verifyXeroWebhookSignature('{}', 'whatever', '')).toBe(false);
  });

  it('returns false when buffer lengths differ (cannot timingSafeEqual)', () => {
    expect(verifyXeroWebhookSignature('{}', 'short', SIGNING_KEY)).toBe(false);
  });

  it('handles the intent-to-receive empty payload — sig over "" is valid', () => {
    const empty = '';
    const sig = sign(empty);
    expect(verifyXeroWebhookSignature(empty, sig, SIGNING_KEY)).toBe(true);
  });

  it('rejects when body whitespace is mutated after signing (raw-bytes invariant)', () => {
    const fragile = '{ "events" : [] }';
    const fragileSig = sign(fragile);
    expect(verifyXeroWebhookSignature(fragile, fragileSig, SIGNING_KEY)).toBe(true);
    const reserialised = JSON.stringify(JSON.parse(fragile));
    expect(verifyXeroWebhookSignature(reserialised, fragileSig, SIGNING_KEY)).toBe(false);
  });
});

describe('persistXeroWebhookEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventFindFirstMock.mockResolvedValue(null);
    let counter = 0;
    eventCreateMock.mockImplementation(() => Promise.resolve({ id: `evt-${++counter}` }));
    // Default: tenant matches whatever the test event uses (tenant-1).
    getStoredTokensMock.mockResolvedValue({ tenantId: 'tenant-1' });
  });

  it('persists each unique INVOICE event and returns ids', async () => {
    const body = JSON.stringify({
      events: [
        {
          resourceId: 'inv-A',
          eventCategory: 'INVOICE',
          eventType: 'UPDATE',
          tenantId: 'tenant-1',
          eventDateUtc: '2026-04-25T10:00:00Z',
        },
        {
          resourceId: 'inv-B',
          eventCategory: 'INVOICE',
          eventType: 'CREATE',
          tenantId: 'tenant-1',
          eventDateUtc: '2026-04-25T10:00:01Z',
        },
      ],
    });

    const result = await persistXeroWebhookEvents(body);

    expect(result.totalEvents).toBe(2);
    expect(result.persistedIds).toEqual(['evt-1', 'evt-2']);
    expect(eventCreateMock).toHaveBeenCalledTimes(2);
    expect(result.skippedNonInvoice).toBe(0);
    expect(result.skippedDuplicate).toBe(0);
  });

  it('skips non-INVOICE events without persisting them', async () => {
    const body = JSON.stringify({
      events: [
        {
          resourceId: 'contact-A',
          eventCategory: 'CONTACT',
          eventType: 'UPDATE',
          tenantId: 'tenant-1',
          eventDateUtc: '2026-04-25T10:00:00Z',
        },
      ],
    });

    const result = await persistXeroWebhookEvents(body);

    expect(result.skippedNonInvoice).toBe(1);
    expect(result.persistedIds).toEqual([]);
    expect(eventCreateMock).not.toHaveBeenCalled();
  });

  it('detects replay via (tenantId, resourceId, eventDateUtc) and skips dupes', async () => {
    eventFindFirstMock.mockResolvedValueOnce({ id: 'pre-existing' });

    const body = JSON.stringify({
      events: [
        {
          resourceId: 'inv-replay',
          eventCategory: 'INVOICE',
          eventType: 'UPDATE',
          tenantId: 'tenant-1',
          eventDateUtc: '2026-04-25T10:00:00Z',
        },
      ],
    });

    const result = await persistXeroWebhookEvents(body);

    expect(result.skippedDuplicate).toBe(1);
    expect(result.persistedIds).toEqual([]);
    expect(eventCreateMock).not.toHaveBeenCalled();
  });

  it('returns empty counters on a malformed body (signature already verified)', async () => {
    const result = await persistXeroWebhookEvents('not json');

    expect(result.totalEvents).toBe(0);
    expect(result.persistedIds).toEqual([]);
    expect(eventCreateMock).not.toHaveBeenCalled();
  });

  it('computes a stable rawBodyHash for replay tracking', async () => {
    const body = JSON.stringify({ events: [] });
    const result = await persistXeroWebhookEvents(body);
    const expected = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
    expect(result.rawBodyHash).toBe(expected);
  });

  it('drops events whose tenantId does not match the connected tenant', async () => {
    getStoredTokensMock.mockResolvedValueOnce({ tenantId: 'tenant-CURRENT' });

    const body = JSON.stringify({
      events: [
        {
          resourceId: 'inv-foreign',
          eventCategory: 'INVOICE',
          eventType: 'UPDATE',
          tenantId: 'tenant-OLD', // mismatch — should be dropped
          eventDateUtc: '2026-04-25T10:00:00Z',
        },
      ],
    });

    const result = await persistXeroWebhookEvents(body);

    expect(result.skippedWrongTenant).toBe(1);
    expect(result.persistedIds).toEqual([]);
    expect(eventCreateMock).not.toHaveBeenCalled();
  });

  it('keeps events when tenant lookup is unavailable (degrades open)', async () => {
    // If we can't read the connected tenant we still accept events — better
    // to over-process than to silently drop legitimate ones.
    getStoredTokensMock.mockResolvedValueOnce(null);

    const body = JSON.stringify({
      events: [
        {
          resourceId: 'inv-untenanted',
          eventCategory: 'INVOICE',
          eventType: 'UPDATE',
          tenantId: 'tenant-1',
          eventDateUtc: '2026-04-25T10:00:00Z',
        },
      ],
    });

    const result = await persistXeroWebhookEvents(body);
    expect(result.skippedWrongTenant).toBe(0);
    expect(result.persistedIds.length).toBe(1);
  });
});

describe('processPersistedWebhookEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enqueueXeroJobMock.mockResolvedValue('job-id-mock');
  });

  it('resolves invoice → contact → customer and enqueues balance_sync', async () => {
    eventFindUniqueMock.mockResolvedValueOnce({
      id: 'evt-1',
      resourceId: 'inv-1',
      resourceUrl: null,
      eventDateUtc: new Date('2026-04-25T10:00:00Z'),
    });
    fetchInvoiceContactIdMock.mockResolvedValueOnce('xero-contact-1');
    customerFindFirstMock.mockResolvedValueOnce({ id: 'customer-1' });

    const result = await processPersistedWebhookEvent('evt-1');

    expect(result.status).toBe('completed');
    expect(result.jobId).toBe('job-id-mock');
    expect(enqueueXeroJobMock).toHaveBeenCalledWith(
      'balance_sync',
      'customer',
      'customer-1',
      expect.objectContaining({ xeroContactId: 'xero-contact-1', trigger: 'webhook' })
    );
    // Status updated twice: processing → completed
    expect(eventUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'evt-1' },
        data: expect.objectContaining({ status: 'completed' }),
      })
    );
  });

  it('marks event completed (skipped) when invoice has no contact', async () => {
    eventFindUniqueMock.mockResolvedValueOnce({
      id: 'evt-2',
      resourceId: 'inv-2',
      resourceUrl: null,
      eventDateUtc: new Date('2026-04-25T10:00:00Z'),
    });
    fetchInvoiceContactIdMock.mockResolvedValueOnce(null);

    const result = await processPersistedWebhookEvent('evt-2');

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('invoice_has_no_contact');
    expect(enqueueXeroJobMock).not.toHaveBeenCalled();
  });

  it('marks event completed (skipped) when no local customer exists', async () => {
    eventFindUniqueMock.mockResolvedValueOnce({
      id: 'evt-3',
      resourceId: 'inv-3',
      resourceUrl: null,
      eventDateUtc: new Date('2026-04-25T10:00:00Z'),
    });
    fetchInvoiceContactIdMock.mockResolvedValueOnce('xero-contact-orphan');
    customerFindFirstMock.mockResolvedValueOnce(null);

    const result = await processPersistedWebhookEvent('evt-3');

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('no_local_customer');
    expect(enqueueXeroJobMock).not.toHaveBeenCalled();
  });

  it('marks event failed on unexpected error', async () => {
    eventFindUniqueMock.mockResolvedValueOnce({
      id: 'evt-4',
      resourceId: 'inv-4',
      resourceUrl: null,
      eventDateUtc: new Date('2026-04-25T10:00:00Z'),
    });
    fetchInvoiceContactIdMock.mockRejectedValueOnce(new Error('Xero down'));

    const result = await processPersistedWebhookEvent('evt-4');

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('Xero down');
    expect(eventUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed', error: 'Xero down' }),
      })
    );
  });
});
