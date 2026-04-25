/**
 * Backfill Order Coordinates
 *
 * One-shot hotfix script to backfill latitude/longitude on existing orders whose
 * deliveryAddress.latitude or deliveryAddress.longitude is null, missing, or 0.
 *
 * Background: customer.create / customer.update were updated to geocode addresses,
 * but the customer order create mutation copies deliveryAddress verbatim from the
 * customer. Orders placed before the customer was geocoded (or when geocoding
 * silently failed) inherit null coords, which breaks route auto-optimization.
 *
 * Coordinate-sourcing strategy for each affected order:
 *   1. If the customer's current deliveryAddress now has valid coords, copy those
 *      onto the order. Source: 'customer'.
 *   2. Otherwise, geocode the order's own deliveryAddress via Mapbox v6
 *      (NEXT_PUBLIC_MAPBOX_TOKEN), then SuburbAreaMapping fallback. Source:
 *      'mapbox' or 'suburbMapping'.
 *   3. If both fail, skip and report under "needs manual attention".
 *
 * The script does NOT write back to the customer record — that is the
 * customer-side backfill's job.
 *
 * Usage:
 *   pnpm --filter @joho-erp/database backfill:order-coords         # dry-run
 *   pnpm --filter @joho-erp/database backfill:order-coords:apply   # update DB
 */

import { PrismaClient } from '../generated/prisma';
import * as dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient({ log: ['error', 'warn'] });

const isApply = process.argv.includes('--apply');
const isDryRun = !isApply;

interface AddressInput {
  street: string;
  suburb: string;
  state: string;
  postcode: string;
}

async function geocodeAddressCoordinates(
  address: AddressInput
): Promise<{ latitude: number | null; longitude: number | null; source: 'mapbox' | 'suburbMapping' | 'none' }> {
  let latitude: number | null = null;
  let longitude: number | null = null;
  let source: 'mapbox' | 'suburbMapping' | 'none' = 'none';

  const mapboxToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  if (mapboxToken) {
    try {
      const fullAddress = `${address.street}, ${address.suburb}, ${address.state} ${address.postcode}, Australia`;
      const encodedAddress = encodeURIComponent(fullAddress);
      const geocodeUrl = `https://api.mapbox.com/search/geocode/v6/forward?q=${encodedAddress}&access_token=${mapboxToken}&country=AU&limit=1&types=address,secondary_address`;

      const geocodeResponse = await fetch(geocodeUrl);
      if (geocodeResponse.ok) {
        const geocodeData = await geocodeResponse.json();
        if (geocodeData.features && geocodeData.features.length > 0) {
          const feature = geocodeData.features[0];
          latitude = feature.properties.coordinates.latitude;
          longitude = feature.properties.coordinates.longitude;
          source = 'mapbox';
        }
      }
    } catch (geocodeError) {
      console.warn(`  Mapbox geocoding failed: ${(geocodeError as Error).message}`);
    }
  }

  if (latitude === null || longitude === null) {
    const suburbMapping = await prisma.suburbAreaMapping.findFirst({
      where: {
        suburb: { equals: address.suburb, mode: 'insensitive' },
        state: address.state,
        isActive: true,
      },
    });
    if (suburbMapping) {
      latitude = suburbMapping.latitude;
      longitude = suburbMapping.longitude;
      source = 'suburbMapping';
    }
  }

  return { latitude, longitude, source };
}

function hasValidCoords(addr: { latitude?: number | null; longitude?: number | null } | null | undefined) {
  if (!addr) return false;
  const lat = addr.latitude;
  const lng = addr.longitude;
  return !!lat && !!lng && lat !== 0 && lng !== 0;
}

async function main() {
  console.log('='.repeat(80));
  console.log(`ORDER COORDINATE BACKFILL ${isDryRun ? '(DRY RUN)' : '(APPLYING)'}`);
  console.log(`Generated: ${new Date().toISOString()}`);
  console.log('='.repeat(80));

  if (!process.env.NEXT_PUBLIC_MAPBOX_TOKEN) {
    console.error('\n❌ NEXT_PUBLIC_MAPBOX_TOKEN is not set. Mapbox geocoding will be skipped.');
    console.error('   Only orders whose customer has valid coords or whose suburb is in');
    console.error('   SuburbAreaMapping will be backfilled.');
  }

  // Order.deliveryAddress is a composite type. Prisma cannot filter on inner null fields
  // for embedded composites, so we fetch all orders and filter in-memory.
  const allOrders = await prisma.order.findMany({
    select: {
      id: true,
      orderNumber: true,
      deliveryAddress: true,
      customer: {
        select: {
          deliveryAddress: true,
        },
      },
    },
  });

  const affected = allOrders.filter((o) => !hasValidCoords(o.deliveryAddress));

  console.log(`\nScanned ${allOrders.length} orders; ${affected.length} are missing coordinates.\n`);

  if (affected.length === 0) {
    console.log('✅ Nothing to backfill.');
    return;
  }

  let fixedFromCustomer = 0;
  let fixedFromGeocode = 0;
  let needsManual = 0;
  const manualList: Array<{ id: string; orderNumber: string; address: string; reason: string }> = [];

  for (const order of affected) {
    const addr = order.deliveryAddress;
    const fullAddr =
      addr && addr.street
        ? `${addr.street}, ${addr.suburb}, ${addr.state} ${addr.postcode}`
        : '(incomplete)';

    process.stdout.write(`→ ${order.orderNumber} — ${fullAddr} ... `);

    // 1. Try customer's current coords first.
    const customerAddr = order.customer?.deliveryAddress;
    if (hasValidCoords(customerAddr)) {
      const lat = customerAddr!.latitude!;
      const lng = customerAddr!.longitude!;
      console.log(`${lat.toFixed(4)}, ${lng.toFixed(4)} (customer)${isDryRun ? ' [dry-run]' : ''}`);

      if (!isDryRun) {
        await prisma.order.update({
          where: { id: order.id },
          data: {
            deliveryAddress: {
              ...addr,
              latitude: lat,
              longitude: lng,
            },
          },
        });
      }
      fixedFromCustomer++;
      continue;
    }

    // 2. Fall back to geocoding the order's own address.
    if (!addr || !addr.street || !addr.suburb || !addr.state || !addr.postcode) {
      console.log('INCOMPLETE ADDRESS');
      needsManual++;
      manualList.push({
        id: order.id,
        orderNumber: order.orderNumber,
        address: fullAddr,
        reason: 'incomplete address',
      });
      continue;
    }

    try {
      const coords = await geocodeAddressCoordinates({
        street: addr.street,
        suburb: addr.suburb,
        state: addr.state,
        postcode: addr.postcode,
      });

      if (!coords.latitude || !coords.longitude) {
        console.log('NO MATCH');
        needsManual++;
        manualList.push({
          id: order.id,
          orderNumber: order.orderNumber,
          address: fullAddr,
          reason: 'no geocode match',
        });
        continue;
      }

      console.log(
        `${coords.latitude.toFixed(4)}, ${coords.longitude.toFixed(4)} (${coords.source})${isDryRun ? ' [dry-run]' : ''}`
      );

      if (!isDryRun) {
        await prisma.order.update({
          where: { id: order.id },
          data: {
            deliveryAddress: {
              ...addr,
              latitude: coords.latitude,
              longitude: coords.longitude,
            },
          },
        });
      }
      fixedFromGeocode++;
    } catch (error) {
      console.log(`ERROR: ${(error as Error).message}`);
      needsManual++;
      manualList.push({
        id: order.id,
        orderNumber: order.orderNumber,
        address: fullAddr,
        reason: (error as Error).message,
      });
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));
  console.log(`Scanned:                       ${allOrders.length}`);
  console.log(`Affected (no coords):          ${affected.length}`);
  console.log(`Fixed from customer${isDryRun ? ' (would)' : '       '}: ${fixedFromCustomer}`);
  console.log(`Fixed from geocode${isDryRun ? '  (would)' : '       '}: ${fixedFromGeocode}`);
  console.log(`Needs manual fix:              ${needsManual}`);

  if (manualList.length > 0) {
    console.log('\nOrders needing manual attention:');
    for (const m of manualList) {
      console.log(`  - ${m.orderNumber} (${m.id}) — ${m.address} [${m.reason}]`);
    }
  }

  if (isDryRun && affected.length > 0) {
    console.log('\n👉 Re-run with --apply to persist changes.');
  }
}

main()
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
