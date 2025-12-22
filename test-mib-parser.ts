#!/usr/bin/env node

/**
 * MIB Parser and Tree Builder Test Script
 *
 * Tests the 3-pass approach with ARISTA MIB files
 */

import { readFileSync } from 'fs';
import { parseMibModule } from './src/lib/mib-parser';
import { MibTreeBuilder } from './src/lib/mib-tree-builder';

console.log('=== MIB Parser and Tree Builder Test ===\n');

// Test 1: Parse ARISTA-SMI-MIB alone
console.log('Test 1: Parse ARISTA-SMI-MIB.txt');
console.log('─'.repeat(50));

try {
  const smiContent = readFileSync('./tmp/ARISTA-SMI-MIB.txt', 'utf-8');
  const smiModule = parseMibModule(smiContent);

  console.log(`Module name: ${smiModule.moduleName}`);
  console.log(`Objects: ${smiModule.objects.length}`);
  console.log(`Imports: ${smiModule.imports.size}`);

  // List OBJECT-IDENTITY nodes
  const objectIdentities = smiModule.objects.filter(obj => obj.type === 'OBJECT-IDENTITY');
  console.log(`\nOBJECT-IDENTITY nodes: ${objectIdentities.length}`);
  objectIdentities.forEach(obj => {
    console.log(`  - ${obj.name} (parent: ${obj.parentName}, subid: ${obj.subid})`);
  });

  console.log('✓ Test 1 passed\n');
} catch (error) {
  console.error('✗ Test 1 failed:', error.message);
  process.exit(1);
}

// Test 2: Build tree with ARISTA-SMI-MIB only
console.log('Test 2: Build tree with ARISTA-SMI-MIB only');
console.log('─'.repeat(50));

try {
  const smiContent = readFileSync('./tmp/ARISTA-SMI-MIB.txt', 'utf-8');
  const smiModule = parseMibModule(smiContent);

  const builder = new MibTreeBuilder();
  const tree = builder.buildTree([smiModule]);

  console.log(`Root nodes: ${tree.length}`);

  // Find aristaProducts node
  function findNode(nodes, name) {
    for (const node of nodes) {
      if (node.name === name) return node;
      const found = findNode(node.children, name);
      if (found) return found;
    }
    return null;
  }

  const aristaProducts = findNode(tree, 'aristaProducts');
  if (aristaProducts) {
    console.log(`\nFound aristaProducts:`);
    console.log(`  OID: ${aristaProducts.oid}`);
    console.log(`  Type: ${aristaProducts.type}`);
    console.log(`  Children: ${aristaProducts.children.length}`);
  } else {
    throw new Error('aristaProducts not found in tree');
  }

  console.log('✓ Test 2 passed\n');
} catch (error) {
  console.error('✗ Test 2 failed:', error.message);
  process.exit(1);
}

// Test 3: Build tree with both ARISTA-SMI-MIB and ARISTA-PRODUCTS-MIB
console.log('Test 3: Build tree with ARISTA-SMI-MIB + ARISTA-PRODUCTS-MIB');
console.log('─'.repeat(50));

try {
  const smiContent = readFileSync('./tmp/ARISTA-SMI-MIB.txt', 'utf-8');
  const productsContent = readFileSync('./tmp/ARISTA-PRODUCTS-MIB.txt', 'utf-8');

  const smiModule = parseMibModule(smiContent);
  const productsModule = parseMibModule(productsContent);

  console.log(`ARISTA-PRODUCTS-MIB imports: ${productsModule.imports.size}`);
  console.log(`ARISTA-PRODUCTS-MIB objects: ${productsModule.objects.length}`);

  const builder = new MibTreeBuilder();
  const tree = builder.buildTree([smiModule, productsModule]);

  console.log(`\nRoot nodes: ${tree.length}`);

  // Find aristaProducts node
  function findNode(nodes, name) {
    for (const node of nodes) {
      if (node.name === name) return node;
      const found = findNode(node.children, name);
      if (found) return found;
    }
    return null;
  }

  const aristaProducts = findNode(tree, 'aristaProducts');
  if (!aristaProducts) {
    throw new Error('aristaProducts not found in tree');
  }

  console.log(`\nFound aristaProducts:`);
  console.log(`  OID: ${aristaProducts.oid}`);
  console.log(`  Type: ${aristaProducts.type}`);
  console.log(`  Children: ${aristaProducts.children.length}`);

  if (aristaProducts.children.length === 0) {
    throw new Error('aristaProducts should have children from ARISTA-PRODUCTS-MIB');
  }

  // Show first 3 children
  console.log(`\nFirst 3 children:`);
  aristaProducts.children.slice(0, 3).forEach(child => {
    console.log(`  - ${child.name} (${child.oid})`);
  });

  console.log('\n✓ Test 3 passed\n');
} catch (error) {
  console.error('✗ Test 3 failed:', error.message);
  console.error(error.stack);
  process.exit(1);
}

// Test 4: Test missing MIB detection
console.log('Test 4: Test missing MIB detection');
console.log('─'.repeat(50));

try {
  // Try to build tree with only ARISTA-PRODUCTS-MIB (missing ARISTA-SMI-MIB)
  const productsContent = readFileSync('./tmp/ARISTA-PRODUCTS-MIB.txt', 'utf-8');
  const productsModule = parseMibModule(productsContent);

  const builder = new MibTreeBuilder();

  let errorThrown = false;
  try {
    builder.buildTree([productsModule]);
  } catch (error) {
    errorThrown = true;
    console.log(`Expected error: ${error.message}`);

    if (!error.message.includes('Missing MIB dependencies')) {
      throw new Error('Error message should mention missing MIB dependencies');
    }

    if (!error.message.includes('ARISTA-SMI-MIB')) {
      throw new Error('Error message should mention ARISTA-SMI-MIB as missing');
    }
  }

  if (!errorThrown) {
    throw new Error('Should have thrown error for missing ARISTA-SMI-MIB');
  }

  console.log('✓ Test 4 passed\n');
} catch (error) {
  console.error('✗ Test 4 failed:', error.message);
  process.exit(1);
}

console.log('='.repeat(50));
console.log('✓ All tests passed!');
console.log('='.repeat(50));
