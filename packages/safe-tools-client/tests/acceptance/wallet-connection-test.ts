import { truncateMiddle } from '@cardstack/ember-shared/helpers/truncate-middle';
import HubAuthenticationService from '@cardstack/safe-tools-client/services/hub-authentication';
import SafesService, {
  Safe,
  TokenBalance,
} from '@cardstack/safe-tools-client/services/safes';
import ScheduledPaymentsService from '@cardstack/safe-tools-client/services/scheduled-payments';

import {
  click,
  settled,
  TestContext,
  visit,
  waitFor,
} from '@ember/test-helpers';
import percySnapshot from '@percy/ember';
import { BigNumber } from 'ethers';
import { setupWorker, rest, SetupWorkerApi } from 'msw';
import { module, test } from 'qunit';

import {
  TEST_ACCOUNT_1,
  TEST_ACCOUNT_2,
  CHAIN_ID,
  setupApplicationTest,
} from '../helpers';

let currentAccount: string;
module('Acceptance | wallet connection', function (hooks) {
  setupApplicationTest(hooks);
  let mockServiceWorker: SetupWorkerApi;

  hooks.beforeEach(function (this: TestContext) {
    const safesService = this.owner.lookup('service:safes') as SafesService;
    const hubAuthenticationService = this.owner.lookup(
      'service:hub-authentication'
    ) as HubAuthenticationService;

    safesService.fetchSafes = (): Promise<Safe[]> => {
      return Promise.resolve([
        {
          address: '0x458Bb61A22A0e91855d6D876C88706cfF7bD486E',
          spModuleAddress: '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2',
        },
      ]);
    };

    safesService.fetchTokenBalances = (): Promise<TokenBalance[]> => {
      return Promise.resolve([
        {
          symbol: 'ETH',
          balance: BigNumber.from('1000000000000000000'),
          decimals: 18,
          isNativeToken: true,
        } as unknown as TokenBalance,
        {
          symbol: 'USDT',
          balance: BigNumber.from('10000000'),
          decimals: 6,
        } as unknown as TokenBalance,
      ]);
    };

    //@ts-expect-error - don't care about the promise return value since this is a mock
    hubAuthenticationService.getHubAuth = (): Promise<unknown> => {
      return Promise.resolve({
        authenticate: async () => {
          return Promise.resolve(
            currentAccount === TEST_ACCOUNT_1
              ? 'auth-token-1337-account-1'
              : 'auth-token-1337-account-2'
          );
        },
        checkValidAuth: async () => {
          return Promise.resolve(true);
        },
      });
    };

    const scheduledPaymentsService = this.owner.lookup(
      'service:scheduled-payments'
    ) as ScheduledPaymentsService;

    scheduledPaymentsService.fetchScheduledPayments = (): Promise<[]> => {
      return Promise.resolve([]);
    };
    currentAccount = TEST_ACCOUNT_1;

    const handlers = [
      rest.get('/hub-test/api/config', (_req, res, ctx) => {
        return res(
          ctx.status(200),
          ctx.json({
            data: {
              attributes: {
                web3: {
                  schedulerNetworks: ['mainnet', 'polygon'],
                },
              },
            },
          })
        );
      }),
    ];
    mockServiceWorker = setupWorker(...handlers);
    mockServiceWorker.start({
      onUnhandledRequest(req, { warning }) {
        if (
          req.url.href.match(/trust-wallet.com|\.png|\.svg|\.ttf|\/assets\//)
        ) {
          return;
        }
        warning();
      },
    });
  });

  hooks.afterEach(function () {
    mockServiceWorker.stop();
  });

  module('With Metamask', function () {
    // eslint-disable-next-line qunit/require-expect
    test('connecting wallet', async function (assert) {
      await visit('/schedule');
      await click('.connect-button__button');
      await click('[data-test-wallet-option="metamask"]');

      assert.dom(
        '.boxel-radio-option__input boxel-radio-option__input--hidden-radio boxel-radio-option__input--checked'
      );
      assert
        .dom('[data-test-schedule-form-connect-wallet-cta]')
        .includesText('Step 1 - First connect your wallet');

      await click('[data-test-connect-wallet-button-modal]');

      assert
        .dom('[data-test-wallet-address] .blockchain-address')
        .hasText(truncateMiddle([TEST_ACCOUNT_1]));

      assert
        .dom('[data-test-safe-address-label] .blockchain-address')
        .hasText('0x458B...486E');
      assert.dom('[data-test-token-balance="ETH"]').hasText('1 ETH');
      assert.dom('[data-test-token-balance="USDT"]').hasText('10 USDT');

      await waitFor('[data-test-hub-auth-modal]');
      await percySnapshot('before hub auth prompt');
      await click('[data-test-hub-auth-modal] button');
      assert.dom('[data-test-hub-auth-modal]').doesNotExist();

      const storage = this.owner.lookup('storage:local') as Storage;
      let authToken = storage.getItem(
        `authToken-${TEST_ACCOUNT_1}-${CHAIN_ID}`
      );
      assert.deepEqual(authToken, 'auth-token-1337-account-1');

      await percySnapshot('after hub auth prompt');

      currentAccount = TEST_ACCOUNT_2;
      await this.mockMetaMask.mockAccountsChanged([TEST_ACCOUNT_2]);

      await settled();
      assert
        .dom('[data-test-wallet-address] .blockchain-address')
        .hasText(truncateMiddle([TEST_ACCOUNT_2]));
      assert
        .dom('[data-test-wallet-address] .blockchain-address')
        .doesNotContainText(truncateMiddle([TEST_ACCOUNT_1]));
      assert.dom('[data-test-schedule-form-connect-wallet-cta]').doesNotExist();

      await waitFor('[data-test-hub-auth-modal]');
      await click('[data-test-hub-auth-modal] button');
      assert.dom('[data-test-hub-auth-modal]').doesNotExist();

      authToken = storage.getItem(`authToken-${TEST_ACCOUNT_1}-${CHAIN_ID}`);
      assert.deepEqual(authToken, 'auth-token-1337-account-1');

      await click('[data-test-disconnect-button]');

      assert.dom('[data-test-wallet-address]').doesNotExist();

      assert.dom('[data-test-connect-wallet-button-modal-sidebar]').exists();
      assert.dom('[data-test-disconnect-button]').doesNotExist();
      assert.dom('[data-test-safe-address-label]').doesNotExist();
    });

    test('connecting wallet to unsupported network', async function (assert) {
      this.mockMetaMask.mockChainChanged('5');
      await visit('/schedule');
      await click('.connect-button__button');
      await click('[data-test-wallet-option="metamask"]');

      assert.dom(
        '.boxel-radio-option__input boxel-radio-option__input--hidden-radio boxel-radio-option__input--checked'
      );
      assert
        .dom('[data-test-schedule-form-connect-wallet-cta]')
        .includesText('Step 1 - First connect your wallet');

      await click('[data-test-connect-wallet-button-modal]');

      assert.dom('.network-connect-modal').doesNotExist();
      assert.dom('[data-test-general-info-modal]').exists();
    });
  });

  module('With Wallet Connect', function () {
    test('connecting wallet', async function (assert) {
      this.mockWalletConnect.mockMainnet();
      await visit('/schedule');
      await click('.connect-button__button');

      await click('[data-test-wallet-option="wallet-connect"]');

      assert.dom(
        '.boxel-radio-option__input boxel-radio-option__input--hidden-radio boxel-radio-option__input--checked'
      );

      await click('[data-test-connect-wallet-button-modal]');

      currentAccount = TEST_ACCOUNT_2;
      this.mockWalletConnect.mockAccountsChanged([TEST_ACCOUNT_2]);

      await waitFor('[data-test-hub-auth-modal]');
      await click('[data-test-hub-auth-modal] button');
      assert.dom('[data-test-hub-auth-modal]').doesNotExist();

      assert
        .dom('[data-test-wallet-address] .blockchain-address')
        .hasText(truncateMiddle([TEST_ACCOUNT_2]));

      assert
        .dom('[data-test-safe-address-label] .blockchain-address')
        .hasText('0x458B...486E');
      assert.dom('[data-test-token-balance="ETH"]').hasText('1 ETH');
      assert.dom('[data-test-token-balance="USDT"]').hasText('10 USDT');
    });
  });

  test('connecting wallet to unsupported network', async function (assert) {
    this.mockWalletConnect.mockMainnet();
    this.mockWalletConnect.mockChainChanged('5');
    await visit('/schedule');
    await click('.connect-button__button');

    await click('[data-test-wallet-option="wallet-connect"]');

    assert.dom(
      '.boxel-radio-option__input boxel-radio-option__input--hidden-radio boxel-radio-option__input--checked'
    );

    await click('[data-test-connect-wallet-button-modal]');

    await waitFor('[data-test-general-info-modal]');
    assert.dom('.network-connect-modal').doesNotExist();
    assert.dom('[data-test-general-info-modal]').exists();
  });
});

module(
  'Acceptance | wallet connection | Remembering the selected chain',
  function (hooks) {
    setupApplicationTest(hooks);
    test('Defaults to mainnet', async function (assert) {
      await visit('/schedule');
      await click('[data-test-connect-wallet-button-modal-sidebar]');
      assert
        .dom('[data-test-connect-wallet-button-modal]')
        .hasAttribute('data-test-connect-wallet-button-modal-chain-id', '1');
    });
    module('with localstorage', function (hooks) {
      hooks.beforeEach(function (this: TestContext) {
        this.mockLocalStorage.setItem('cardstack-cached-network', 'goerli');
      });
      test('Uses localstorage value for other', async function (assert) {
        await visit('/schedule');
        await click('[data-test-connect-wallet-button-modal-sidebar]');
        assert
          .dom('[data-test-connect-wallet-button-modal]')
          .hasAttribute('data-test-connect-wallet-button-modal-chain-id', '5');
      });
    });
  }
);
