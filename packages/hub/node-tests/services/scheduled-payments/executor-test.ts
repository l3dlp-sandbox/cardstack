import { registry, setupHub } from '../../helpers/server';
import { nowUtc } from '../../../utils/dates';
import { ExtendedPrismaClient } from '../../../services/prisma-manager';
import ScheduledPaymentsExecutorService from '../../../services/scheduled-payments/executor';
import { setupStubWorkerClient } from '../../helpers/stub-worker-client';
import BN from 'bn.js';
import CrankNonceLock from '../../../services/crank-nonce-lock';
import cryptoRandomString from 'crypto-random-string';
import shortUuid from 'short-uuid';
import { ScheduledPayment } from '@prisma/client';

let sdkError: Error | null = null;

const stubbedSchedulePaymentModule = {
  executeScheduledPayment: async (
    _moduleAddress: any,
    _tokenAddress: any,
    _amount: any,
    _payeeAddress: any,
    _feeFixedUsd: any,
    _feePercentage: any,
    _executionGasEstimation: any,
    _maxGasPrice: 'any',
    _gasTokenAddress: any,
    _salt: any,
    _payAt: any,
    _gasPrice: any,
    _recurringDayOfMonth: any,
    _recurringUntil: any,
    { onTxnHash }: any
  ) => {
    if (sdkError) {
      throw sdkError;
    }
    await onTxnHash('0x123');
    return Promise.resolve();
  },
};

class StubCardpaySDK {
  getSDK(sdk: string) {
    switch (sdk) {
      case 'ScheduledPaymentModule':
        return Promise.resolve(stubbedSchedulePaymentModule);
      default:
        throw new Error(`unsupported mock cardpay sdk: ${sdk}`);
    }
  }
}

describe('executing scheduled payments', function () {
  let { getJobIdentifiers, getJobPayloads } = setupStubWorkerClient(this);
  let subject: ScheduledPaymentsExecutorService;
  let prisma: ExtendedPrismaClient;
  let crankNonceLock: CrankNonceLock;

  this.beforeEach(async function () {
    registry(this).register('cardpay', StubCardpaySDK);
  });

  let { getPrisma, getContainer } = setupHub(this);

  this.beforeEach(async function () {
    subject = (await getContainer().lookup('scheduled-payment-executor')) as ScheduledPaymentsExecutorService;
    subject.getCurrentGasPrice = async () => {
      return {
        gasPrice: '1000',
        gasPriceInGasToken: '1000000000',
      };
    };
    subject.fetchTokenToUsdcRate = async () => {
      return 1;
    };
    prisma = await getPrisma();
    crankNonceLock = (await getContainer().lookup('crank-nonce-lock')) as CrankNonceLock;
    crankNonceLock.withNonce = async (chainId: number, cb: (nonce: BN) => Promise<any>) => {
      if (chainId) {
        let nonce = new BN(1);
        return await cb(nonce);
      }
    };
  });

  it('executes a scheduled payment and spawns the task to wait for the transaction to finish', async function () {
    let scheduledPayment = await prisma.scheduledPayment.create({
      data: {
        id: shortUuid.uuid(),
        senderSafeAddress: '0xc0ffee254729296a45a3885639AC7E10F9d54979',
        moduleAddress: '0x7E7d0B97D663e268bB403eb4d72f7C0C7650a6dd',
        tokenAddress: '0xa455bbB2A81E09E0337c13326BBb302Cb37D7cf6',
        gasTokenAddress: '0x6A50E3807FB9cD0B07a79F64e561B9873D3b132E',
        amount: '100',
        payeeAddress: '0x821f3Ee0FbE6D1aCDAC160b5d120390Fb8D2e9d3',
        executionGasEstimation: 100000,
        maxGasPrice: '1000000000',
        feeFixedUsd: '0',
        feePercentage: '0',
        salt: '54lt',
        payAt: nowUtc(),
        spHash: cryptoRandomString({ length: 10 }),
        chainId: 1,
        userAddress: '0x57022DA74ec3e6d8274918C732cf8864be7da833',
        creationTransactionHash: null,
      },
    });

    await subject.executePayment(scheduledPayment, 3, {} as any, stubbedSchedulePaymentModule as any);

    let scheduledPaymentAttempts = await prisma.scheduledPaymentAttempt.findMany({
      where: {
        scheduledPaymentId: scheduledPayment.id,
      },
    });

    expect(scheduledPaymentAttempts.length).to.equal(1);
    expect(scheduledPaymentAttempts[0].status).to.equal('inProgress');
    expect(Number(scheduledPaymentAttempts[0].executionGasPrice)).to.lte(Number(scheduledPayment.maxGasPrice));
    expect(getJobIdentifiers()[0]).to.equal('scheduled-payment-on-chain-execution-waiter');
    expect(getJobPayloads()[0]).to.deep.equal({ scheduledPaymentAttemptId: scheduledPaymentAttempts[0].id });

    // Reload the payment to ensure that lastScheduledPaymentAttemptId is updated
    scheduledPayment = (await prisma.scheduledPayment.findUnique({
      where: {
        id: scheduledPayment.id,
      },
    })) as ScheduledPayment;

    expect(scheduledPayment.lastScheduledPaymentAttemptId).to.equal(scheduledPaymentAttempts[0].id);
  });

  it("sets the scheduled payment's status to 'failed' if the transaction fails", async function () {
    sdkError = new Error('UnknownHash');

    // We create otherScheduledPayment and make a failed payment attempt so that we can test that scheduledPaymentAttemptsInLastPaymentCycleCount on the scheduledPayment is updated correctly and
    // it doesn't include the failed payment attempt from otherScheduledPayment
    let otherScheduledPayment = await prisma.scheduledPayment.create({
      data: {
        id: shortUuid.uuid(),
        senderSafeAddress: '0xc0ffee254729296a45a3885639AC7E10F9d54979',
        moduleAddress: '0x7E7d0B97D663e268bB403eb4d72f7C0C7650a6dd',
        tokenAddress: '0xa455bbB2A81E09E0337c13326BBb302Cb37D7cf6',
        gasTokenAddress: '0x6A50E3807FB9cD0B07a79F64e561B9873D3b132E',
        amount: '100',
        payeeAddress: '0x821f3Ee0FbE6D1aCDAC160b5d120390Fb8D2e9d3',
        executionGasEstimation: 100000,
        maxGasPrice: '1000000000',
        feeFixedUsd: '0',
        feePercentage: '0',
        salt: '54lt',
        payAt: nowUtc(),
        spHash: cryptoRandomString({ length: 10 }),
        chainId: 1,
        userAddress: '0x57022DA74ec3e6d8274918C732cf8864be7da833',
        creationTransactionHash: null,
      },
    });

    await expect(subject.executePayment(otherScheduledPayment, 3, {} as any, stubbedSchedulePaymentModule as any)).to.be
      .rejected;

    let scheduledPayment = await prisma.scheduledPayment.create({
      data: {
        id: shortUuid.uuid(),
        senderSafeAddress: '0xc0ffee254729296a45a3885639AC7E10F9d54979',
        moduleAddress: '0x7E7d0B97D663e268bB403eb4d72f7C0C7650a6dd',
        tokenAddress: '0xa455bbB2A81E09E0337c13326BBb302Cb37D7cf6',
        gasTokenAddress: '0x6A50E3807FB9cD0B07a79F64e561B9873D3b132E',
        amount: '100',
        payeeAddress: '0x821f3Ee0FbE6D1aCDAC160b5d120390Fb8D2e9d3',
        executionGasEstimation: 100000,
        maxGasPrice: '1000000000',
        feeFixedUsd: '0',
        feePercentage: '0',
        salt: '54lt',
        payAt: nowUtc(),
        spHash: cryptoRandomString({ length: 10 }),
        chainId: 1,
        userAddress: '0x57022DA74ec3e6d8274918C732cf8864be7da833',
        creationTransactionHash: null,
      },
    });

    await expect(subject.executePayment(scheduledPayment, 3, {} as any, stubbedSchedulePaymentModule as any)).to.be
      .rejected;

    let scheduledPaymentAttempts = await prisma.scheduledPaymentAttempt.findMany({
      where: {
        scheduledPaymentId: scheduledPayment.id,
      },
    });
    expect(scheduledPaymentAttempts.length).to.equal(1);
    expect(scheduledPaymentAttempts[0].status).to.equal('failed');
    expect(scheduledPaymentAttempts[0].failureReason).to.equal('UnknownHash');

    // Reload the payment to ensure that scheduledPaymentAttemptsInLastPaymentCycleCount and nextRetryAttemptAt were updated
    scheduledPayment = (await prisma.scheduledPayment.findUnique({
      where: {
        id: scheduledPayment.id,
      },
    })) as ScheduledPayment;

    expect(scheduledPayment.scheduledPaymentAttemptsInLastPaymentCycleCount).to.equal(1);
    expect(scheduledPayment.nextRetryAttemptAt).to.be.greaterThan(nowUtc());
    expect(scheduledPayment.lastScheduledPaymentAttemptId).to.equal(scheduledPaymentAttempts[0].id);
  });
});
