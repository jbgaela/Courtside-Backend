import { Prisma, PrismaClient } from '@prisma/client';
import { isProduction, isTest } from '../config/env.js';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: isTest ? [] : isProduction ? ['error', 'warn'] : ['warn', 'error'],
  });

if (!isProduction) globalForPrisma.prisma = prisma;

export type PrismaTransaction = Prisma.TransactionClient;
export type DbClient = PrismaClient | PrismaTransaction;
