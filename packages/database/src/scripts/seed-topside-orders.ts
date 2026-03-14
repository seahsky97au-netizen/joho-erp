/**
 * Database Seed Script: Create Beef Topside Orders
 *
 * This script creates one Beef Topside order for every active customer
 * in the database, with delivery scheduled for tomorrow.
 *
 * Usage:
 *   pnpm db:seed-topside-orders --dry-run              # Preview orders to be created
 *   pnpm db:seed-topside-orders --count 10 --confirm   # Create orders for 10 customers
 *   pnpm db:seed-topside-orders --confirm              # Create orders for all customers
 */

import { PrismaClient, OrderStatus } from '../generated/prisma';
import * as dotenv from 'dotenv';
import {
  createMoney,
  multiplyMoney,
  toCents,
  generateOrderNumber,
  calculateOrderTotals,
  isCustomPriceValid,
  getTomorrowInMelbourne,
  isSundayInMelbourne,
  parseMelbourneDate,
} from '@joho-erp/shared';

// Load environment variables
dotenv.config();

const prisma = new PrismaClient({
  log: ['error', 'warn'],
});

// ============================================================================
// Types
// ============================================================================

interface CustomerPricingData {
  id: string;
  customerId: string;
  productId: string;
  customPrice: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface CustomerWithPricing {
  id: string;
  businessName: string;
  clerkUserId: string;
  deliveryAddress: {
    street: string;
    suburb: string;
    state: string;
    postcode: string;
    country: string;
    areaId: string | null;
    areaName: string | null;
    latitude: number | null;
    longitude: number | null;
    deliveryInstructions: string | null;
  };
  customerPricing: CustomerPricingData[];
}

interface ProductData {
  id: string;
  sku: string;
  name: string;
  basePrice: number;
  unit: string;
  applyGst: boolean;
  gstRate: number | null;
}

interface GeneratedOrderItem {
  productId: string;
  sku: string;
  productName: string;
  unit: string;
  quantity: number;
  unitPrice: number; // in cents
  subtotal: number; // in cents
  applyGst: boolean;
  gstRate: number | null;
}

interface GeneratedOrder {
  orderNumber: string;
  customerId: string;
  customerName: string;
  items: GeneratedOrderItem[];
  subtotal: number; // in cents
  taxAmount: number; // in cents
  totalAmount: number; // in cents
  deliveryAddress: CustomerWithPricing['deliveryAddress'];
  requestedDeliveryDate: Date;
  status: OrderStatus;
  statusHistory: Array<{
    status: string;
    changedAt: Date;
    changedBy: string;
    changedByName: string | null;
    changedByEmail: string | null;
    notes: string | null;
  }>;
  orderedAt: Date;
  createdBy: string;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get tomorrow's delivery date in Melbourne timezone, skipping Sunday.
 * Sets the time to 8:00 AM.
 */
function getDeliveryDate(): Date {
  let dateString = getTomorrowInMelbourne();

  // If tomorrow is Sunday, advance to Monday
  if (isSundayInMelbourne(dateString)) {
    const sunday = new Date(dateString);
    sunday.setDate(sunday.getDate() + 1);
    dateString = sunday.toISOString().split('T')[0];
  }

  const date = parseMelbourneDate(dateString);
  date.setHours(8, 0, 0, 0);
  return date;
}

/**
 * Get the effective price for a product considering customer-specific pricing
 */
function getEffectivePrice(
  product: ProductData,
  customerPricing: CustomerWithPricing['customerPricing']
): number {
  const customPricing = customerPricing.find((cp) => cp.productId === product.id);

  if (customPricing && isCustomPriceValid(customPricing)) {
    return customPricing.customPrice;
  }

  return product.basePrice;
}

/**
 * Generate a single Beef Topside order for a customer
 */
function generateOrder(
  customer: CustomerWithPricing,
  product: ProductData,
  deliveryDate: Date
): GeneratedOrder {
  const orderNumber = generateOrderNumber();
  const orderedAt = new Date();

  // Random integer quantity 1-20 kg
  const quantity = Math.floor(Math.random() * 20) + 1;
  const unitPrice = getEffectivePrice(product, customer.customerPricing);

  const unitPriceMoney = createMoney(unitPrice);
  const subtotalMoney = multiplyMoney(unitPriceMoney, quantity);
  const subtotal = toCents(subtotalMoney);

  const items: GeneratedOrderItem[] = [
    {
      productId: product.id,
      sku: product.sku,
      productName: product.name,
      unit: product.unit,
      quantity,
      unitPrice,
      subtotal,
      applyGst: product.applyGst,
      gstRate: product.gstRate,
    },
  ];

  const totals = calculateOrderTotals(items);

  const statusHistory = [
    {
      status: 'confirmed',
      changedAt: orderedAt,
      changedBy: 'seed_script',
      changedByName: 'Seed Script',
      changedByEmail: null,
      notes: 'Beef Topside order created by seed script',
    },
  ];

  return {
    orderNumber,
    customerId: customer.id,
    customerName: customer.businessName,
    items,
    subtotal: totals.subtotal,
    taxAmount: totals.taxAmount,
    totalAmount: totals.totalAmount,
    deliveryAddress: customer.deliveryAddress,
    requestedDeliveryDate: deliveryDate,
    status: OrderStatus.confirmed,
    statusHistory,
    orderedAt,
    createdBy: customer.clerkUserId,
  };
}

// ============================================================================
// Main Script
// ============================================================================

function printUsage(): void {
  console.log(`
Database Seed Script: Create Beef Topside Orders

Creates one Beef Topside order for every active customer in the database,
with delivery scheduled for tomorrow.

Usage:
  pnpm db:seed-topside-orders --dry-run              Preview orders to be created
  pnpm db:seed-topside-orders --count 10 --confirm   Create orders for 10 customers
  pnpm db:seed-topside-orders --confirm              Create orders for all customers

Flags:
  --dry-run     Preview orders without creating them
  --confirm     Execute the seeding (required for safety)
  --count N     Limit to N customers (default: all active customers)
  --help        Show this help message
`);
}

function formatCurrency(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function printOrderPreview(order: GeneratedOrder, index: number): void {
  const item = order.items[0];
  console.log(`
  ─────────────────────────────────────────────────────────
  Order #${index + 1}: ${order.orderNumber}
  ─────────────────────────────────────────────────────────
  Customer:      ${order.customerName}
  Delivery:      ${order.deliveryAddress.suburb}, ${order.deliveryAddress.state}
  Delivery Date: ${order.requestedDeliveryDate.toDateString()}

  Item:
    - ${item.sku}: ${item.productName}
      ${item.quantity} ${item.unit} @ ${formatCurrency(item.unitPrice)} = ${formatCurrency(item.subtotal)}${item.applyGst ? ' +GST' : ''}

  Subtotal:      ${formatCurrency(order.subtotal)}
  GST:           ${formatCurrency(order.taxAmount)}
  Total:         ${formatCurrency(order.totalAmount)}
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Parse command line arguments
  const isDryRun = args.includes('--dry-run');
  const isConfirmed = args.includes('--confirm');
  const showHelp = args.includes('--help') || args.includes('-h');

  // Parse count argument
  const countIndex = args.indexOf('--count');
  const countArg = countIndex !== -1 && args[countIndex + 1] ? parseInt(args[countIndex + 1], 10) : null;

  if (countArg !== null && (isNaN(countArg) || countArg < 1)) {
    console.error('\n  Error: --count must be a positive number\n');
    process.exit(1);
  }

  // Show help if requested or no valid arguments
  if (showHelp || (!isDryRun && !isConfirmed)) {
    printUsage();
    process.exit(showHelp ? 0 : 1);
  }

  console.log('\n' + '='.repeat(60));
  console.log('   DATABASE SEED: Create Beef Topside Orders');
  console.log('='.repeat(60));

  try {
    // Connect to database
    console.log('\nConnecting to database...');
    await prisma.$connect();
    console.log('Connected successfully.');

    // Find the Beef Topside product
    console.log('\nLooking up Beef Topside product...');
    const product = (await prisma.product.findFirst({
      where: {
        name: { contains: 'topside', mode: 'insensitive' },
        status: 'active',
      },
      select: {
        id: true,
        sku: true,
        name: true,
        basePrice: true,
        unit: true,
        applyGst: true,
        gstRate: true,
      },
    })) as ProductData | null;

    if (!product) {
      console.error('\n  Error: No active product found with "topside" in its name.');
      console.error('  Please ensure a Beef Topside product exists and is active.\n');
      await prisma.$disconnect();
      process.exit(1);
    }

    console.log(`  Found: ${product.sku} - ${product.name} @ ${formatCurrency(product.basePrice)}/kg`);

    // Fetch active customers with their custom pricing
    console.log('\nFetching active customers...');
    const customers = (await prisma.customer.findMany({
      where: { status: 'active' as const },
      include: {
        customerPricing: {
          select: {
            id: true,
            customerId: true,
            productId: true,
            customPrice: true,
            effectiveFrom: true,
            effectiveTo: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
      take: countArg ?? undefined,
    })) as unknown as CustomerWithPricing[];
    console.log(`  Found ${customers.length} active customers${countArg ? ` (limited to ${countArg})` : ''}`);

    if (customers.length === 0) {
      console.log('\n  No active customers found. Run seed-customers first.\n');
      await prisma.$disconnect();
      process.exit(0);
    }

    // Check existing orders
    const existingCount = await prisma.order.count();
    console.log(`  Existing orders in database: ${existingCount}`);

    // Calculate delivery date once (same for all orders)
    const deliveryDate = getDeliveryDate();
    console.log(`\n  Delivery date: ${deliveryDate.toDateString()}`);

    // Generate orders
    console.log(`\nGenerating ${customers.length} Beef Topside orders...`);
    const orders: GeneratedOrder[] = [];

    for (const customer of customers) {
      const order = generateOrder(customer, product, deliveryDate);
      orders.push(order);
    }

    // Preview orders
    if (isDryRun) {
      console.log('\n' + '─'.repeat(60));
      console.log('  DRY RUN MODE - No changes will be made');
      console.log('─'.repeat(60));

      for (let i = 0; i < Math.min(orders.length, 5); i++) {
        printOrderPreview(orders[i], i);
      }

      if (orders.length > 5) {
        console.log(`\n  ... and ${orders.length - 5} more orders`);
      }

      // Summary statistics
      const totalValue = orders.reduce((sum, o) => sum + o.totalAmount, 0);
      const avgOrderValue = Math.round(totalValue / orders.length);
      const ordersWithGst = orders.filter((o) => o.taxAmount > 0).length;

      let customPricingCount = 0;
      for (const order of orders) {
        const customer = customers.find((c) => c.id === order.customerId);
        if (customer) {
          const customPricing = customer.customerPricing.find((cp) => cp.productId === product.id);
          if (customPricing && isCustomPriceValid(customPricing)) {
            customPricingCount++;
          }
        }
      }

      const quantities = orders.map((o) => o.items[0].quantity);
      const avgQty = (quantities.reduce((a, b) => a + b, 0) / quantities.length).toFixed(1);

      console.log('\n  Summary:');
      console.log(`    Product:                ${product.name} (${product.sku})`);
      console.log(`    Base price:             ${formatCurrency(product.basePrice)}/kg`);
      console.log(`    Orders to create:       ${orders.length}`);
      console.log(`    Avg quantity:           ${avgQty} kg`);
      console.log(`    Total value:            ${formatCurrency(totalValue)}`);
      console.log(`    Average order value:    ${formatCurrency(avgOrderValue)}`);
      console.log(`    Orders with GST:        ${ordersWithGst}/${orders.length}`);
      console.log(`    With custom pricing:    ${customPricingCount}/${orders.length}`);
      console.log(`    Delivery date:          ${deliveryDate.toDateString()}`);
      console.log('\n  Run with --confirm to create these orders.\n');

      await prisma.$disconnect();
      process.exit(0);
    }

    // Create orders
    console.log('\n' + '─'.repeat(60));
    console.log('  CREATING ORDERS');
    console.log('─'.repeat(60));

    let created = 0;

    for (const order of orders) {
      await prisma.order.create({
        data: {
          orderNumber: order.orderNumber,
          customerId: order.customerId,
          customerName: order.customerName,
          items: order.items,
          subtotal: order.subtotal,
          taxAmount: order.taxAmount,
          totalAmount: order.totalAmount,
          deliveryAddress: order.deliveryAddress,
          requestedDeliveryDate: order.requestedDeliveryDate,
          status: order.status,
          statusHistory: order.statusHistory,
          orderedAt: order.orderedAt,
          createdBy: order.createdBy,
        },
      });

      created++;
      console.log(
        `  [${created}/${orders.length}] Created: ${order.orderNumber} for ${order.customerName} ` +
          `(${order.items[0].quantity} kg, ${formatCurrency(order.totalAmount)})`
      );
    }

    // Success summary
    const totalValue = orders.reduce((sum, o) => sum + o.totalAmount, 0);

    console.log('\n' + '='.repeat(60));
    console.log('   SEEDING COMPLETED');
    console.log('='.repeat(60));
    console.log(`\n  - Product: ${product.name} (${product.sku})`);
    console.log(`  - Created: ${created} orders`);
    console.log(`  - Total value: ${formatCurrency(totalValue)}`);
    console.log(`  - Delivery date: ${deliveryDate.toDateString()}`);
    console.log(`  - Total orders in database: ${existingCount + created}\n`);

    await prisma.$disconnect();
    process.exit(0);
  } catch (error) {
    console.error('\n' + '='.repeat(60));
    console.error('   SEEDING FAILED');
    console.error('='.repeat(60));

    if (error instanceof Error) {
      console.error(`\n  Error: ${error.message}`);
      if (error.stack) {
        console.error(`\n  Stack trace:\n${error.stack}`);
      }
    } else {
      console.error('\n  Unknown error:', error);
    }

    await prisma.$disconnect();
    process.exit(1);
  }
}

// Run the script
main();
