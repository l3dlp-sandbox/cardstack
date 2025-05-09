import { ExtendedPrismaClient } from '../../services/prisma-manager';
import { setupHub } from '../helpers/server';

describe('NotificationPreferenceService', function () {
  let { getPrisma, lookup } = setupHub(this);
  let prisma: ExtendedPrismaClient;

  this.beforeEach(async function () {
    prisma = await getPrisma();

    await prisma.notificationType.createMany({
      data: [
        {
          id: '73994d4b-bb3a-4d73-969f-6fa24da16fb4',
          notificationType: 'merchant_claim',
          defaultStatus: 'enabled',
        },
        {
          id: '2cbe34e4-f41d-41d5-b7d2-ee875dc7c588',
          notificationType: 'customer_payment',
          defaultStatus: 'enabled',
        },
      ],
    });

    await prisma.pushNotificationRegistration.createMany({
      data: [
        // 1st device
        {
          id: 'f6942dbf-1422-4c3f-baa3-24f0c5b5d475',
          ownerAddress: '0x01',
          pushClientId: '123',
          disabledAt: null,
        },

        // 2nd device
        {
          id: '5ffa1144-6a8d-4a43-98bd-ce526f48b7e4',
          ownerAddress: '0x01',
          pushClientId: '124',
          disabledAt: null,
        },

        // 3rd device, disabled
        {
          id: 'c7ef64dd-a608-4f0a-8a48-ce58c66e7f20',
          ownerAddress: '0x01',
          pushClientId: '125',
          disabledAt: new Date(Date.parse('2021-12-09T10:28:16.921')),
        },

        // device from some other EOA
        {
          id: '6ab0df2c-880d-433d-8e37-fb916afaf6ec',
          ownerAddress: '0x02',
          pushClientId: '888',
          disabledAt: null,
        },
      ],
    });

    // Preference override for 1st device
    await prisma.notificationPreference.updateStatus({
      ownerAddress: '0x01',
      pushClientId: '123',
      notificationType: 'customer_payment',
      status: 'disabled',
    });
  });

  it('returns preferences for an EOA', async function () {
    let service = await lookup('notification-preference-service');

    let preferences = await service.getPreferences('0x01');

    // 1st device (123) has a preference override for customer_payment
    // 2nd device (124) has default preferences
    expect(preferences).to.deep.equal([
      {
        notificationType: 'merchant_claim',
        ownerAddress: '0x01',
        pushClientId: '123',
        status: 'enabled',
      },
      {
        notificationType: 'customer_payment',
        ownerAddress: '0x01',
        pushClientId: '123',
        status: 'disabled',
      },
      {
        notificationType: 'merchant_claim',
        ownerAddress: '0x01',
        pushClientId: '124',
        status: 'enabled',
      },
      {
        notificationType: 'customer_payment',
        ownerAddress: '0x01',
        pushClientId: '124',
        status: 'enabled',
      },
    ]);
  });

  it('returns which devices should receive a notification for an EOA and notification type', async function () {
    let service = await lookup('notification-preference-service');

    expect(await service.getEligiblePushClientIds('0x01', 'customer_payment')).to.deep.equal(['124']);
    expect(await service.getEligiblePushClientIds('0x01', 'merchant_claim')).to.deep.equal(['123', '124']);
  });
});
