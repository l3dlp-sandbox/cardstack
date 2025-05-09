import { module, test } from 'qunit';
import { visit, waitFor } from '@ember/test-helpers';
import { setupApplicationTest } from 'ember-qunit';
import percySnapshot from '@percy/ember';
import Layer2TestWeb3Strategy from '@cardstack/web-client/utils/web3-strategies/test-layer2';
import { setupMirage } from 'ember-cli-mirage/test-support';

import { MirageTestContext } from 'ember-cli-mirage/test-support';
import {
  createProfileSafe,
  getFilenameFromDid,
} from '@cardstack/web-client/utils/test-factories';

interface Context extends MirageTestContext {}

const EXAMPLE_DID = 'did:cardstack:1moVYMRNGv6E5Ca3t7aXVD2Yb11e4e91103f084a';

function createMockMerchantSafe(
  eoaAddress: string,
  profileSafeAddress: string
) {
  return createProfileSafe({
    address: profileSafeAddress,
    owners: [eoaAddress],
    infoDID: EXAMPLE_DID,
  });
}

module('Acceptance | payments dashboard', function (hooks) {
  setupApplicationTest(hooks);
  setupMirage(hooks);

  test('Merchant cards are hidden when wallet is not connected', async function (assert) {
    await visit('/card-pay/payments');

    assert.dom('[data-test-profiles-section]').doesNotExist();
  });

  // eslint-disable-next-line qunit/require-expect
  test('Profiles are listed when wallet is connected and update when the account changes', async function (this: Context, assert) {
    let layer2Service = this.owner.lookup('service:layer2-network')
      .strategy as Layer2TestWeb3Strategy;

    let layer2AccountAddress = '0x182619c6Ea074C053eF3f1e1eF81Ec8De6Eb6E44';
    layer2Service.test__simulateRemoteAccountSafes(layer2AccountAddress, [
      createMockMerchantSafe(
        layer2AccountAddress,
        '0x212619c6Ea074C053eF3f1e1eF81Ec8De6Eb6F33'
      ),
    ]);
    await layer2Service.test__simulateAccountsChanged([layer2AccountAddress]);

    this.server.create('profile', {
      id: await getFilenameFromDid(EXAMPLE_DID),
      name: 'Mandello',
      slug: 'mandello1',
      did: EXAMPLE_DID,
      color: '#00ffcc',
      'text-color': '#000000',
      'owner-address': layer2AccountAddress,
    });

    await visit('/card-pay/payments');

    await waitFor('[data-test-profiles-section]');
    assert
      .dom('[data-test-profiles-section] [data-test-safe]')
      .exists({ count: 1 });

    // we don't want to allow additional profiles right now
    assert.dom('[data-test-workflow-button="create-business"]').doesNotExist();

    assert.dom('[data-test-safe-title]').containsText('Mandello');
    assert.dom('[data-test-safe-footer-business-id]').containsText('mandello1');
    assert.dom('[data-test-safe-footer-managers]').containsText('1 Owner');
    assert.dom('[data-test-profile-logo-background="#00ffcc"]').exists();
    assert.dom('[data-test-profile-logo-text-color="#000000"]').exists();

    await percySnapshot(assert);
  });
});
