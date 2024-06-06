import ffmpegPath from '@ffmpeg-installer/ffmpeg';
import { Boom } from '@hapi/boom';
import makeWASocket, {
  AnyMessageContent,
  BufferedEventData,
  BufferJSON,
  CacheStore,
  Chat,
  ConnectionState,
  Contact,
  delay,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  generateWAMessageFromContent,
  getAggregateVotesInPollMessage,
  getContentType,
  getDevice,
  GroupMetadata,
  isJidBroadcast,
  isJidGroup,
  isJidUser,
  makeCacheableSignalKeyStore,
  MessageUpsertType,
  MiscMessageGenerationOptions,
  ParticipantAction,
  PHONENUMBER_MCC,
  prepareWAMessageMedia,
  proto,
  useMultiFileAuthState,
  UserFacingSocketConfig,
  WABrowserDescription,
  WAMediaUpload,
  WAMessage,
  WAMessageUpdate,
  WAPresence,
  WASocket,
} from '@whiskeysockets/baileys';
import { Label } from '@whiskeysockets/baileys/lib/Types/Label';
import { LabelAssociation } from '@whiskeysockets/baileys/lib/Types/LabelAssociation';
import axios from 'axios';
import { exec } from 'child_process';
import { isBase64, isURL } from 'class-validator';
import EventEmitter2 from 'eventemitter2';
// import ffmpeg from 'fluent-ffmpeg';
import fs, { existsSync, readFileSync } from 'fs';
import { parsePhoneNumber } from 'libphonenumber-js';
import Long from 'long';
import NodeCache from 'node-cache';
import { getMIMEType } from 'node-mime-types';
import { release } from 'os';
import { join } from 'path';
import P from 'pino';
import qrcode, { QRCodeToDataURLOptions } from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import sharp from 'sharp';

import { CacheEngine } from '../../../cache/cacheengine';
import {
  CacheConf,
  ConfigService,
  configService,
  ConfigSessionPhone,
  Database,
  Log,
  ProviderSession,
  QrCode,
} from '../../../config/env.config';
import { INSTANCE_DIR } from '../../../config/path.config';
import { BadRequestException, InternalServerErrorException, NotFoundException } from '../../../exceptions';
import { makeProxyAgent } from '../../../utils/makeProxyAgent';
import useMultiFileAuthStatePrisma from '../../../utils/use-multi-file-auth-state-prisma';
import { AuthStateProvider } from '../../../utils/use-multi-file-auth-state-provider-files';
import { useMultiFileAuthStateRedisDb } from '../../../utils/use-multi-file-auth-state-redis-db';
import {
  ArchiveChatDto,
  BlockUserDto,
  DeleteMessage,
  getBase64FromMediaMessageDto,
  LastMessage,
  MarkChatUnreadDto,
  NumberBusiness,
  OnWhatsAppDto,
  PrivacySettingDto,
  ReadMessageDto,
  SendPresenceDto,
  UpdateMessageDto,
  WhatsAppNumberDto,
} from '../../dto/chat.dto';
import {
  AcceptGroupInvite,
  CreateGroupDto,
  GetParticipant,
  GroupDescriptionDto,
  GroupInvite,
  GroupJid,
  GroupPictureDto,
  GroupSendInvite,
  GroupSubjectDto,
  GroupToggleEphemeralDto,
  GroupUpdateParticipantDto,
  GroupUpdateSettingDto,
} from '../../dto/group.dto';
import { InstanceDto, SetPresenceDto } from '../../dto/instance.dto';
import { HandleLabelDto, LabelDto } from '../../dto/label.dto';
import {
  ContactMessage,
  MediaMessage,
  Options,
  SendAudioDto,
  SendContactDto,
  SendListDto,
  SendLocationDto,
  SendMediaDto,
  SendPollDto,
  SendReactionDto,
  SendStatusDto,
  SendStickerDto,
  SendTextDto,
  StatusMessage,
} from '../../dto/sendMessage.dto';
import { chatwootImport } from '../../integrations/chatwoot/utils/chatwoot-import-helper';
import { ProviderFiles } from '../../provider/sessions';
import { PrismaRepository } from '../../repository/repository.service';
import { waMonitor } from '../../server.module';
import { Events, MessageSubtype, TypeMediaMessage, wa } from '../../types/wa.types';
import { CacheService } from './../cache.service';
import { ChannelStartupService } from './../channel.service';

const groupMetadataCache = new CacheService(new CacheEngine(configService, 'groups').getEngine());

export class BaileysStartupService extends ChannelStartupService {
  constructor(
    public readonly configService: ConfigService,
    public readonly eventEmitter: EventEmitter2,
    public readonly prismaRepository: PrismaRepository,
    public readonly cache: CacheService,
    public readonly chatwootCache: CacheService,
    public readonly baileysCache: CacheService,
    private readonly providerFiles: ProviderFiles,
  ) {
    super(configService, eventEmitter, prismaRepository, chatwootCache);
    this.logger.verbose('BaileysStartupService initialized');
    this.cleanStore();
    this.instance.qrcode = { count: 0 };
    this.mobile = false;
    this.recoveringMessages();
    this.cronForceUpdateGroupMetadataCache();

    this.authStateProvider = new AuthStateProvider(this.providerFiles);
  }

  private authStateProvider: AuthStateProvider;
  private readonly msgRetryCounterCache: CacheStore = new NodeCache();
  private readonly userDevicesCache: CacheStore = new NodeCache();
  private endSession = false;
  private logBaileys = this.configService.get<Log>('LOG').BAILEYS;

  public stateConnection: wa.StateConnection = { state: 'close' };

  public phoneNumber: string;
  public mobile: boolean;

  private async recoveringMessages() {
    this.logger.info('Recovering messages lost');
    const cacheConf = this.configService.get<CacheConf>('CACHE');

    if ((cacheConf?.REDIS?.ENABLED && cacheConf?.REDIS?.URI !== '') || cacheConf?.LOCAL?.ENABLED) {
      setInterval(async () => {
        this.baileysCache.keys().then((keys) => {
          keys.forEach(async (key) => {
            const message = await this.baileysCache.get(key.split(':')[2]);

            if (message.messageStubParameters && message.messageStubParameters[0] === 'Message absent from node') {
              this.logger.info('Message absent from node, retrying to send, key: ' + key.split(':')[2]);
              await this.client.sendMessageAck(JSON.parse(message.messageStubParameters[1], BufferJSON.reviver));
            }
          });
        });
      }, 30000);
    }
  }

  private async cronForceUpdateGroupMetadataCache() {
    if (
      !this.configService.get<CacheConf>('CACHE').REDIS.ENABLED &&
      !this.configService.get<CacheConf>('CACHE').LOCAL.ENABLED
    )
      return;

    await this.forceUpdateGroupMetadataCache();

    setInterval(async () => {
      await this.forceUpdateGroupMetadataCache();
    }, 3600000);
  }

  private async forceUpdateGroupMetadataCache() {
    this.logger.verbose('Forcing update group metadata cache');
    const groups = await this.fetchAllGroups({ getParticipants: 'false' });

    for (const group of groups) {
      await this.updateGroupMetadataCache(group.id);
    }
  }

  public get connectionStatus() {
    this.logger.verbose('Getting connection status');
    return this.stateConnection;
  }

  public async logoutInstance() {
    this.logger.verbose('logging out instance: ' + this.instanceName);
    await this.client?.logout('Log out instance: ' + this.instanceName);

    this.logger.verbose('close connection instance: ' + this.instanceName);
    this.client?.ws?.close();
  }

  public async getProfileName() {
    this.logger.verbose('Getting profile name');

    let profileName = this.client.user?.name ?? this.client.user?.verifiedName;
    if (!profileName) {
      this.logger.verbose('Profile name not found, trying to get from database');
      if (this.configService.get<Database>('DATABASE').ENABLED) {
        this.logger.verbose('Database enabled, trying to get from database');

        const data = await this.prismaRepository.session.findUnique({
          where: { sessionId: this.instanceId },
        });

        if (data) {
          this.logger.verbose('Profile name found in database');
          const creds = JSON.parse(JSON.stringify(data.creds), BufferJSON.reviver);
          profileName = creds.me?.name || creds.me?.verifiedName;
        }
      } else if (existsSync(join(INSTANCE_DIR, this.instanceName, 'creds.json'))) {
        this.logger.verbose('Profile name found in file');
        const creds = JSON.parse(
          readFileSync(join(INSTANCE_DIR, this.instanceName, 'creds.json'), {
            encoding: 'utf-8',
          }),
        );
        profileName = creds.me?.name || creds.me?.verifiedName;
      }
    }

    this.logger.verbose(`Profile name: ${profileName}`);
    return profileName;
  }

  public async getProfileStatus() {
    this.logger.verbose('Getting profile status');
    const status = await this.client.fetchStatus(this.instance.wuid);

    this.logger.verbose(`Profile status: ${status.status}`);
    return status.status;
  }

  public get profilePictureUrl() {
    this.logger.verbose('Getting profile picture url');
    return this.instance.profilePictureUrl;
  }

  public get qrCode(): wa.QrCode {
    this.logger.verbose('Getting qrcode');

    return {
      pairingCode: this.instance.qrcode?.pairingCode,
      code: this.instance.qrcode?.code,
      base64: this.instance.qrcode?.base64,
      count: this.instance.qrcode?.count,
    };
  }

  private async connectionUpdate({ qr, connection, lastDisconnect }: Partial<ConnectionState>) {
    this.logger.verbose('Connection update');
    if (qr) {
      this.logger.verbose('QR code found');
      if (this.instance.qrcode.count === this.configService.get<QrCode>('QRCODE').LIMIT) {
        this.logger.verbose('QR code limit reached');

        this.logger.verbose('Sending data to webhook in event QRCODE_UPDATED');
        this.sendDataWebhook(Events.QRCODE_UPDATED, {
          message: 'QR code limit reached, please login again',
          statusCode: DisconnectReason.badSession,
        });

        if (this.localChatwoot.enabled) {
          this.chatwootService.eventWhatsapp(
            Events.QRCODE_UPDATED,
            { instanceName: this.instance.name },
            {
              message: 'QR code limit reached, please login again',
              statusCode: DisconnectReason.badSession,
            },
          );
        }

        this.logger.verbose('Sending data to webhook in event CONNECTION_UPDATE');
        this.sendDataWebhook(Events.CONNECTION_UPDATE, {
          instance: this.instance.name,
          state: 'refused',
          statusReason: DisconnectReason.connectionClosed,
        });

        this.logger.verbose('endSession defined as true');
        this.endSession = true;

        this.logger.verbose('Emmiting event logout.instance');
        return this.eventEmitter.emit('no.connection', this.instance.name);
      }

      this.logger.verbose('Incrementing QR code count');
      this.instance.qrcode.count++;

      const color = this.configService.get<QrCode>('QRCODE').COLOR;

      const optsQrcode: QRCodeToDataURLOptions = {
        margin: 3,
        scale: 4,
        errorCorrectionLevel: 'H',
        color: { light: '#ffffff', dark: color },
      };

      if (this.phoneNumber) {
        await delay(2000);
        this.instance.qrcode.pairingCode = await this.client.requestPairingCode(this.phoneNumber);
      } else {
        this.instance.qrcode.pairingCode = null;
      }

      this.logger.verbose('Generating QR code');
      qrcode.toDataURL(qr, optsQrcode, (error, base64) => {
        if (error) {
          this.logger.error('Qrcode generate failed:' + error.toString());
          return;
        }

        this.instance.qrcode.base64 = base64;
        this.instance.qrcode.code = qr;

        this.sendDataWebhook(Events.QRCODE_UPDATED, {
          qrcode: {
            instance: this.instance.name,
            pairingCode: this.instance.qrcode.pairingCode,
            code: qr,
            base64,
          },
        });

        if (this.localChatwoot.enabled) {
          this.chatwootService.eventWhatsapp(
            Events.QRCODE_UPDATED,
            { instanceName: this.instance.name },
            {
              qrcode: {
                instance: this.instance.name,
                pairingCode: this.instance.qrcode.pairingCode,
                code: qr,
                base64,
              },
            },
          );
        }
      });

      this.logger.verbose('Generating QR code in terminal');
      qrcodeTerminal.generate(qr, { small: true }, (qrcode) =>
        this.logger.log(
          `\n{ instance: ${this.instance.name} pairingCode: ${this.instance.qrcode.pairingCode}, qrcodeCount: ${this.instance.qrcode.count} }\n` +
            qrcode,
        ),
      );
    }

    if (connection) {
      this.logger.verbose('Connection found');
      this.stateConnection = {
        state: connection,
        statusReason: (lastDisconnect?.error as Boom)?.output?.statusCode ?? 200,
      };

      this.logger.verbose('Sending data to webhook in event CONNECTION_UPDATE');
      this.sendDataWebhook(Events.CONNECTION_UPDATE, {
        instance: this.instance.name,
        ...this.stateConnection,
      });
    }

    if (connection === 'close') {
      this.logger.verbose('Connection closed');
      const shouldReconnect = (lastDisconnect.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        this.logger.verbose('Reconnecting to whatsapp');
        await this.connectToWhatsapp();
      } else {
        this.logger.verbose('Do not reconnect to whatsapp');
        this.logger.verbose('Sending data to webhook in event STATUS_INSTANCE');
        this.sendDataWebhook(Events.STATUS_INSTANCE, {
          instance: this.instance.name,
          status: 'closed',
        });

        if (this.localChatwoot.enabled) {
          this.chatwootService.eventWhatsapp(
            Events.STATUS_INSTANCE,
            { instanceName: this.instance.name },
            {
              instance: this.instance.name,
              status: 'closed',
            },
          );
        }

        this.logger.verbose('Emittin event logout.instance');
        this.eventEmitter.emit('logout.instance', this.instance.name, 'inner');
        this.client?.ws?.close();
        this.client.end(new Error('Close connection'));
        this.logger.verbose('Connection closed');
      }
    }

    if (connection === 'open') {
      this.logger.verbose('Connection opened');
      this.instance.wuid = this.client.user.id.replace(/:\d+/, '');
      this.instance.profilePictureUrl = (await this.profilePicture(this.instance.wuid)).profilePictureUrl;
      const formattedWuid = this.instance.wuid.split('@')[0].padEnd(30, ' ');
      const formattedName = this.instance.name;
      this.logger.info(
        `
        ┌──────────────────────────────┐
        │    CONNECTED TO WHATSAPP     │
        └──────────────────────────────┘`.replace(/^ +/gm, '  '),
      );
      this.logger.info(
        `
        wuid: ${formattedWuid}
        name: ${formattedName}
      `,
      );

      if (this.localChatwoot.enabled) {
        this.chatwootService.eventWhatsapp(
          Events.CONNECTION_UPDATE,
          { instanceName: this.instance.name },
          {
            instance: this.instance.name,
            status: 'open',
          },
        );
      }
    }

    if (connection === 'connecting') {
      if (this.mobile) this.sendMobileCode();
    }
  }

  // TODO: Refactor this method for prisma
  private async getMessage(key: proto.IMessageKey, full = false) {
    this.logger.verbose('Getting message with key: ' + JSON.stringify(key));
    try {
      const webMessageInfo = (await this.prismaRepository.message.findFirst({
        where: {
          instanceId: this.instanceId,
          key: {
            path: ['id'],
            equals: key.id,
          },
        },
      })) as unknown as proto.IWebMessageInfo[];
      if (full) {
        this.logger.verbose('Returning full message');
        return webMessageInfo[0];
      }
      if (webMessageInfo[0].message?.pollCreationMessage) {
        this.logger.verbose('Returning poll message');
        const messageSecretBase64 = webMessageInfo[0].message?.messageContextInfo?.messageSecret;

        if (typeof messageSecretBase64 === 'string') {
          const messageSecret = Buffer.from(messageSecretBase64, 'base64');

          const msg = {
            messageContextInfo: {
              messageSecret,
            },
            pollCreationMessage: webMessageInfo[0].message?.pollCreationMessage,
          };

          return msg;
        }
      }

      this.logger.verbose('Returning message');
      return webMessageInfo[0].message;
    } catch (error) {
      return { conversation: '' };
    }
  }

  private async defineAuthState() {
    this.logger.verbose('Defining auth state');
    const db = this.configService.get<Database>('DATABASE');
    const cache = this.configService.get<CacheConf>('CACHE');

    const provider = this.configService.get<ProviderSession>('PROVIDER');

    if (provider?.ENABLED) {
      return await this.authStateProvider.authStateProvider(this.instance.name);
    }

    if (cache?.REDIS.ENABLED && cache?.REDIS.SAVE_INSTANCES) {
      this.logger.info('Redis enabled');
      return await useMultiFileAuthStateRedisDb(this.instance.name, this.cache);
    }

    if (db.SAVE_DATA.INSTANCE && db.ENABLED) {
      this.logger.verbose('Database enabled');
      return await useMultiFileAuthStatePrisma(this.instanceId);
    }

    this.logger.verbose('Store file enabled');
    return await useMultiFileAuthState(join(INSTANCE_DIR, this.instance.name));
  }

  public async connectToWhatsapp(number?: string, mobile?: boolean): Promise<WASocket> {
    this.logger.verbose('Connecting to whatsapp');
    try {
      this.loadWebhook();
      this.loadChatwoot();
      this.loadSettings();
      this.loadWebsocket();
      this.loadRabbitmq();
      this.loadSqs();
      this.loadTypebot();
      this.loadProxy();

      this.instance.authState = await this.defineAuthState();

      if (!mobile) {
        this.mobile = false;
      } else {
        this.mobile = mobile;
      }

      const session = this.configService.get<ConfigSessionPhone>('CONFIG_SESSION_PHONE');
      const browser: WABrowserDescription = [session.CLIENT, session.NAME, release()];
      this.logger.verbose('Browser: ' + JSON.stringify(browser));

      let version;
      let log;

      if (session.VERSION) {
        version = session.VERSION.split(',');
        log = `Baileys version env: ${version}`;
      } else {
        const baileysVersion = await fetchLatestBaileysVersion();
        version = baileysVersion.version;
        log = `Baileys version: ${version}`;
      }

      this.logger.info(log);

      let options;

      if (this.localProxy.enabled) {
        this.logger.info('Proxy enabled: ' + this.localProxy.proxy?.host);

        if (this.localProxy?.proxy?.host?.includes('proxyscrape')) {
          try {
            const response = await axios.get(this.localProxy.proxy?.host);
            const text = response.data;
            const proxyUrls = text.split('\r\n');
            const rand = Math.floor(Math.random() * Math.floor(proxyUrls.length));
            const proxyUrl = 'http://' + proxyUrls[rand];
            options = {
              agent: makeProxyAgent(proxyUrl),
              fetchAgent: makeProxyAgent(proxyUrl),
            };
          } catch (error) {
            this.localProxy.enabled = false;
          }
        } else {
          options = {
            agent: makeProxyAgent(this.localProxy.proxy),
            fetchAgent: makeProxyAgent(this.localProxy.proxy),
          };
        }
      }

      const socketConfig: UserFacingSocketConfig = {
        ...options,
        auth: {
          creds: this.instance.authState.state.creds,
          keys: makeCacheableSignalKeyStore(this.instance.authState.state.keys, P({ level: 'error' }) as any),
        },
        logger: P({ level: this.logBaileys }),
        printQRInTerminal: false,
        mobile,
        browser: number ? ['Chrome (Linux)', session.NAME, release()] : browser,
        version,
        markOnlineOnConnect: this.localSettings.alwaysOnline,
        retryRequestDelayMs: 10,
        connectTimeoutMs: 60_000,
        qrTimeout: 40_000,
        defaultQueryTimeoutMs: undefined,
        emitOwnEvents: false,
        shouldIgnoreJid: (jid) => {
          const isGroupJid = this.localSettings.groupsIgnore && isJidGroup(jid);
          const isBroadcast = !this.localSettings.readStatus && isJidBroadcast(jid);

          return isGroupJid || isBroadcast;
        },
        msgRetryCounterCache: this.msgRetryCounterCache,
        getMessage: async (key) => (await this.getMessage(key)) as Promise<proto.IMessage>,
        generateHighQualityLinkPreview: true,
        syncFullHistory: this.localSettings.syncFullHistory,
        shouldSyncHistoryMessage: (msg: proto.Message.IHistorySyncNotification) => {
          return this.historySyncNotification(msg);
        },
        userDevicesCache: this.userDevicesCache,
        transactionOpts: { maxCommitRetries: 10, delayBetweenTriesMs: 10 },
        patchMessageBeforeSending(message) {
          if (
            message.deviceSentMessage?.message?.listMessage?.listType ===
            proto.Message.ListMessage.ListType.PRODUCT_LIST
          ) {
            message = JSON.parse(JSON.stringify(message));

            message.deviceSentMessage.message.listMessage.listType = proto.Message.ListMessage.ListType.SINGLE_SELECT;
          }

          if (message.listMessage?.listType == proto.Message.ListMessage.ListType.PRODUCT_LIST) {
            message = JSON.parse(JSON.stringify(message));

            message.listMessage.listType = proto.Message.ListMessage.ListType.SINGLE_SELECT;
          }

          return message;
        },
      };

      this.endSession = false;

      this.logger.verbose('Creating socket');

      this.client = makeWASocket(socketConfig);

      this.logger.verbose('Socket created');

      this.eventHandler();

      this.logger.verbose('Socket event handler initialized');

      this.phoneNumber = number;

      return this.client;
    } catch (error) {
      this.logger.error(error);
      throw new InternalServerErrorException(error?.toString());
    }
  }

  private async sendMobileCode() {
    const { registration } = this.client.authState.creds || null;

    let phoneNumber = registration.phoneNumber || this.phoneNumber;

    if (!phoneNumber.startsWith('+')) {
      phoneNumber = '+' + phoneNumber;
    }

    if (!phoneNumber) {
      this.logger.error('Phone number not found');
      return;
    }

    const parsedPhoneNumber = parsePhoneNumber(phoneNumber);

    if (!parsedPhoneNumber?.isValid()) {
      this.logger.error('Phone number invalid');
      return;
    }

    registration.phoneNumber = parsedPhoneNumber.format('E.164');
    registration.phoneNumberCountryCode = parsedPhoneNumber.countryCallingCode;
    registration.phoneNumberNationalNumber = parsedPhoneNumber.nationalNumber;

    const mcc = await PHONENUMBER_MCC[parsedPhoneNumber.countryCallingCode];
    if (!mcc) {
      this.logger.error('MCC not found');
      return;
    }

    registration.phoneNumberMobileCountryCode = mcc;
    registration.method = 'sms';

    try {
      const response = await this.client.requestRegistrationCode(registration);

      if (['ok', 'sent'].includes(response?.status)) {
        this.logger.verbose('Registration code sent successfully');

        return response;
      }
    } catch (error) {
      this.logger.error(error);
    }
  }

  public async receiveMobileCode(code: string) {
    await this.client
      .register(code.replace(/["']/g, '').trim().toLowerCase())
      .then(async () => {
        this.logger.verbose('Registration code received successfully');
      })
      .catch((error) => {
        this.logger.error(error);
      });
  }

  public async reloadConnection(): Promise<WASocket> {
    try {
      this.instance.authState = await this.defineAuthState();

      const session = this.configService.get<ConfigSessionPhone>('CONFIG_SESSION_PHONE');
      const browser: WABrowserDescription = [session.CLIENT, session.NAME, release()];

      let version;
      let log;

      if (session.VERSION) {
        version = session.VERSION.split(',');
        log = `Baileys version env: ${version}`;
      } else {
        const baileysVersion = await fetchLatestBaileysVersion();
        version = baileysVersion.version;
        log = `Baileys version: ${version}`;
      }

      this.logger.info(log);

      let options;

      if (this.localProxy.enabled) {
        this.logger.info('Proxy enabled: ' + this.localProxy.proxy?.host);

        if (this.localProxy?.proxy?.host?.includes('proxyscrape')) {
          try {
            const response = await axios.get(this.localProxy.proxy?.host);
            const text = response.data;
            const proxyUrls = text.split('\r\n');
            const rand = Math.floor(Math.random() * Math.floor(proxyUrls.length));
            const proxyUrl = 'http://' + proxyUrls[rand];
            options = {
              agent: makeProxyAgent(proxyUrl),
              fetchAgent: makeProxyAgent(proxyUrl),
            };
          } catch (error) {
            this.localProxy.enabled = false;
          }
        } else {
          options = {
            agent: makeProxyAgent(this.localProxy.proxy),
            fetchAgent: makeProxyAgent(this.localProxy.proxy),
          };
        }
      }

      const socketConfig: UserFacingSocketConfig = {
        ...options,
        auth: {
          creds: this.instance.authState.state.creds,
          keys: makeCacheableSignalKeyStore(this.instance.authState.state.keys, P({ level: 'error' }) as any),
        },
        logger: P({ level: this.logBaileys }),
        printQRInTerminal: false,
        browser: this.phoneNumber ? ['Chrome (Linux)', session.NAME, release()] : browser,
        version,
        markOnlineOnConnect: this.localSettings.alwaysOnline,
        retryRequestDelayMs: 10,
        connectTimeoutMs: 60_000,
        qrTimeout: 40_000,
        defaultQueryTimeoutMs: undefined,
        emitOwnEvents: false,
        shouldIgnoreJid: (jid) => {
          const isGroupJid = this.localSettings.groupsIgnore && isJidGroup(jid);
          const isBroadcast = !this.localSettings.readStatus && isJidBroadcast(jid);

          return isGroupJid || isBroadcast;
        },
        msgRetryCounterCache: this.msgRetryCounterCache,
        getMessage: async (key) => (await this.getMessage(key)) as Promise<proto.IMessage>,
        generateHighQualityLinkPreview: true,
        syncFullHistory: this.localSettings.syncFullHistory,
        shouldSyncHistoryMessage: (msg: proto.Message.IHistorySyncNotification) => {
          return this.historySyncNotification(msg);
        },
        userDevicesCache: this.userDevicesCache,
        transactionOpts: { maxCommitRetries: 10, delayBetweenTriesMs: 10 },
        patchMessageBeforeSending(message) {
          if (
            message.deviceSentMessage?.message?.listMessage?.listType ===
            proto.Message.ListMessage.ListType.PRODUCT_LIST
          ) {
            message = JSON.parse(JSON.stringify(message));

            message.deviceSentMessage.message.listMessage.listType = proto.Message.ListMessage.ListType.SINGLE_SELECT;
          }

          if (message.listMessage?.listType == proto.Message.ListMessage.ListType.PRODUCT_LIST) {
            message = JSON.parse(JSON.stringify(message));

            message.listMessage.listType = proto.Message.ListMessage.ListType.SINGLE_SELECT;
          }

          return message;
        },
      };

      this.client = makeWASocket(socketConfig);

      return this.client;
    } catch (error) {
      this.logger.error(error);
      throw new InternalServerErrorException(error?.toString());
    }
  }

  private readonly chatHandle = {
    'chats.upsert': async (chats: Chat[]) => {
      this.logger.verbose('Event received: chats.upsert');

      this.logger.verbose('Finding existing chat IDs in the database');
      const existingChatIds = await this.prismaRepository.chat.findMany({
        where: { instanceId: this.instanceId },
        select: { remoteJid: true },
      });

      const existingChatIdSet = new Set(existingChatIds.map((chat) => chat.remoteJid));

      this.logger.verbose('Verifying if chats exist in the database to insert');
      const chatsToInsert = chats
        .filter((chat) => !existingChatIdSet.has(chat.id))
        .map((chat) => ({ remoteJid: chat.id, instanceId: this.instanceId }));

      this.logger.verbose('Sending data to webhook in event CHATS_UPSERT');
      this.sendDataWebhook(Events.CHATS_UPSERT, chatsToInsert);

      if (chatsToInsert.length > 0) {
        this.logger.verbose('Inserting new chats in the database');
        await this.prismaRepository.chat.createMany({
          data: chatsToInsert,
        });
      }
    },

    'chats.update': async (
      chats: Partial<
        proto.IConversation & {
          lastMessageRecvTimestamp?: number;
        } & {
          conditional: (bufferedData: BufferedEventData) => boolean;
        }
      >[],
    ) => {
      this.logger.verbose('Event received: chats.update');
      const chatsRaw = chats.map((chat) => {
        return { remoteJid: chat.id, instanceId: this.instanceId };
      });

      this.logger.verbose('Sending data to webhook in event CHATS_UPDATE');
      this.sendDataWebhook(Events.CHATS_UPDATE, chatsRaw);

      this.logger.verbose('Updating chats in the database');

      for (const chat of chats) {
        await this.prismaRepository.chat.updateMany({
          where: {
            instanceId: this.instanceId,
            remoteJid: chat.id,
          },
          data: {
            lastMsgTimestamp: Long.fromValue(chat.lastMessageRecvTimestamp).toString(),
          },
        });
      }
    },

    'chats.delete': async (chats: string[]) => {
      this.logger.verbose('Event received: chats.delete');

      this.logger.verbose('Deleting chats in database');
      chats.forEach(
        async (chat) =>
          await this.prismaRepository.chat.deleteMany({
            where: { instanceId: this.instanceId, remoteJid: chat },
          }),
      );

      this.logger.verbose('Sending data to webhook in event CHATS_DELETE');
      this.sendDataWebhook(Events.CHATS_DELETE, [...chats]);
    },
  };

  private readonly contactHandle = {
    'contacts.upsert': async (contacts: Contact[]) => {
      try {
        this.logger.verbose('Event received: contacts.upsert');

        const contactsRaw: any = contacts.map((contact) => ({
          remoteJid: contact.id,
          pushName: contact?.name || contact?.verifiedName || contact.id.split('@')[0],
          profilePicUrl: null,
          instanceId: this.instanceId,
        }));

        this.logger.verbose('Sending data to webhook in event CONTACTS_UPSERT');
        if (contactsRaw.length > 0) this.sendDataWebhook(Events.CONTACTS_UPSERT, contactsRaw);

        this.logger.verbose('Inserting contacts in database');
        if (contactsRaw.length > 0) {
          await this.prismaRepository.contact.createMany({
            data: contactsRaw,
            skipDuplicates: true,
          });
        }

        if (this.localChatwoot.enabled && this.localChatwoot.importContacts && contactsRaw.length) {
          this.chatwootService.addHistoryContacts({ instanceName: this.instance.name }, contactsRaw);
          chatwootImport.importHistoryContacts({ instanceName: this.instance.name }, this.localChatwoot);
        }

        this.logger.verbose('Updating profile pictures');
        const updatedContacts = await Promise.all(
          contacts.map(async (contact) => ({
            remoteJid: contact.id,
            pushName: contact?.name || contact?.verifiedName || contact.id.split('@')[0],
            profilePicUrl: (await this.profilePicture(contact.id)).profilePictureUrl,
            instanceId: this.instanceId,
          })),
        );

        this.logger.verbose('Sending data to webhook in event CONTACTS_UPDATE');
        if (updatedContacts.length > 0) this.sendDataWebhook(Events.CONTACTS_UPDATE, updatedContacts);

        this.logger.verbose('Updating contacts in database');
        if (updatedContacts.length > 0) {
          await Promise.all(
            updatedContacts.map((contact) =>
              this.prismaRepository.contact.updateMany({
                where: { remoteJid: contact.remoteJid, instanceId: this.instanceId },
                data: {
                  profilePicUrl: contact.profilePicUrl,
                },
              }),
            ),
          );
        }
      } catch (error) {
        this.logger.error(`Error: ${error.message}`);
      }
    },

    'contacts.update': async (contacts: Partial<Contact>[]) => {
      this.logger.verbose('Event received: contacts.update');

      this.logger.verbose('Verifying if contacts exists in database to update');
      const contactsRaw: any = [];
      for await (const contact of contacts) {
        contactsRaw.push({
          remoteJid: contact.id,
          pushName: contact?.name ?? contact?.verifiedName,
          profilePicUrl: (await this.profilePicture(contact.id)).profilePictureUrl,
          instanceId: this.instanceId,
        });
      }

      this.logger.verbose('Sending data to webhook in event CONTACTS_UPDATE');
      this.sendDataWebhook(Events.CONTACTS_UPDATE, contactsRaw);

      this.logger.verbose('Updating contacts in database');
      this.prismaRepository.contact.updateMany({
        where: { instanceId: this.instanceId },
        data: contactsRaw,
      });
    },
  };

  private readonly messageHandle = {
    'messaging-history.set': async ({
      messages,
      chats,
      contacts,
    }: {
      chats: Chat[];
      contacts: Contact[];
      messages: proto.IWebMessageInfo[];
      isLatest: boolean;
    }) => {
      try {
        this.logger.verbose('Event received: messaging-history.set');

        const instance: InstanceDto = { instanceName: this.instance.name };

        const daysLimitToImport = this.localChatwoot.enabled ? this.localChatwoot.daysLimitImportMessages : 1000;
        this.logger.verbose(`Param days limit import messages is: ${daysLimitToImport}`);

        const date = new Date();
        const timestampLimitToImport = new Date(date.setDate(date.getDate() - daysLimitToImport)).getTime() / 1000;

        const maxBatchTimestamp = Math.max(...messages.map((message) => message.messageTimestamp as number));

        const processBatch = maxBatchTimestamp >= timestampLimitToImport;

        if (!processBatch) {
          this.logger.verbose('Batch ignored by maxTimestamp in this batch');
          return;
        }

        const chatsRaw: any[] = [];
        const chatsRepository = new Set(
          (
            await this.prismaRepository.chat.findMany({
              where: { instanceId: this.instanceId },
            })
          ).map((chat) => chat.remoteJid),
        );

        for (const chat of chats) {
          if (chatsRepository.has(chat.id)) {
            continue;
          }

          chatsRaw.push({
            remoteJid: chat.id,
            instanceId: this.instanceId,
            lastMsgTimestamp: chat.lastMessageRecvTimestamp,
          });
        }

        this.logger.verbose('Sending data to webhook in event CHATS_SET');
        this.sendDataWebhook(Events.CHATS_SET, chatsRaw);

        this.logger.verbose('Inserting chats in database');
        this.prismaRepository.chat.createMany({
          data: chatsRaw,
          skipDuplicates: true,
        });

        const messagesRaw: any[] = [];
        const messagesRepository = new Set(
          chatwootImport.getRepositoryMessagesCache(instance) ??
            (
              await this.prismaRepository.message.findMany({
                select: { key: true },
                where: { instanceId: this.instanceId },
              })
            ).map((message) => {
              const key = message.key as {
                id: string;
              };

              return key.id;
            }),
        );

        if (chatwootImport.getRepositoryMessagesCache(instance) === null) {
          chatwootImport.setRepositoryMessagesCache(instance, messagesRepository);
        }

        for (const m of messages) {
          if (!m.message || !m.key || !m.messageTimestamp) {
            continue;
          }

          if (Long.isLong(m?.messageTimestamp)) {
            m.messageTimestamp = m.messageTimestamp?.toNumber();
          }

          if (m.messageTimestamp <= timestampLimitToImport) {
            continue;
          }

          if (messagesRepository.has(m.key.id)) {
            continue;
          }

          const status: Record<number, wa.StatusMessage> = {
            0: 'ERROR',
            1: 'PENDING',
            2: 'SERVER_ACK',
            3: 'DELIVERY_ACK',
            4: 'READ',
            5: 'PLAYED',
          };

          messagesRaw.push({
            key: m.key,
            pushName: m.pushName || m.key.remoteJid.split('@')[0],
            participant: m.participant,
            message: { ...m.message },
            messageType: getContentType(m.message),
            messageTimestamp: m.messageTimestamp as number,
            status: m.status ? status[m.status] : null,
            instanceId: this.instanceId,
          });
        }

        this.logger.verbose('Sending data to webhook in event MESSAGES_SET');
        this.sendDataWebhook(Events.MESSAGES_SET, [...messagesRaw]);

        this.logger.verbose('Inserting messages in database');
        this.prismaRepository.message.createMany({
          data: messagesRaw,
          skipDuplicates: true,
        });

        if (this.localChatwoot.enabled && this.localChatwoot.importMessages && messagesRaw.length > 0) {
          this.chatwootService.addHistoryMessages(
            instance,
            messagesRaw.filter((msg) => !chatwootImport.isIgnorePhoneNumber(msg.key?.remoteJid)),
          );
        }

        await this.contactHandle['contacts.upsert'](
          contacts
            .filter((c) => !!c.notify ?? !!c.name)
            .map((c) => ({
              id: c.id,
              name: c.name ?? c.notify,
            })),
        );

        contacts = undefined;
        messages = undefined;
        chats = undefined;
      } catch (error) {
        this.logger.error(error);
      }
    },

    'messages.upsert': async (
      {
        messages,
        type,
      }: {
        messages: proto.IWebMessageInfo[];
        type: MessageUpsertType;
      },
      settings: any,
    ) => {
      try {
        this.logger.verbose('Event received: messages.upsert');
        for (const received of messages) {
          if (
            this.localChatwoot.enabled &&
            (received.message?.protocolMessage?.editedMessage || received.message?.editedMessage?.message)
          ) {
            const editedMessage =
              received.message?.protocolMessage || received.message?.editedMessage?.message?.protocolMessage;
            if (editedMessage) {
              this.chatwootService.eventWhatsapp('messages.edit', { instanceName: this.instance.name }, editedMessage);
            }
          }

          if (received.messageStubParameters && received.messageStubParameters[0] === 'Message absent from node') {
            this.logger.info('Recovering message lost');

            await this.baileysCache.set(received.key.id, received);
            continue;
          }

          const retryCache = (await this.baileysCache.get(received.key.id)) || null;

          if (retryCache) {
            this.logger.info('Recovered message lost');
            await this.baileysCache.delete(received.key.id);
          }

          if (
            (type !== 'notify' && type !== 'append') ||
            received.message?.protocolMessage ||
            received.message?.pollUpdateMessage ||
            !received?.message
          ) {
            this.logger.verbose('message rejected');
            return;
          }

          if (Long.isLong(received.messageTimestamp)) {
            received.messageTimestamp = received.messageTimestamp?.toNumber();
          }

          if (settings?.groupsIgnore && received.key.remoteJid.includes('@g.us')) {
            this.logger.verbose('group ignored');
            return;
          }

          let messageRaw: any;

          const isMedia =
            received?.message?.imageMessage ||
            received?.message?.videoMessage ||
            received?.message?.stickerMessage ||
            received?.message?.documentMessage ||
            received?.message?.audioMessage;

          const contentMsg = received?.message[getContentType(received.message)] as any;

          if (this.localWebhook.webhookBase64 === true && isMedia) {
            const buffer = await downloadMediaMessage(
              { key: received.key, message: received?.message },
              'buffer',
              {},
              {
                logger: P({ level: 'error' }) as any,
                reuploadRequest: this.client.updateMediaMessage,
              },
            );

            messageRaw = {
              key: received.key,
              pushName: received.pushName,
              message: {
                ...received.message,
                base64: buffer ? buffer.toString('base64') : undefined,
              },
              contextInfo: contentMsg?.contextInfo,
              messageType: getContentType(received.message),
              messageTimestamp: received.messageTimestamp as number,
              instanceId: this.instanceId,
              source: getDevice(received.key.id),
            };
          } else {
            messageRaw = {
              key: received.key,
              pushName: received.pushName,
              message: { ...received.message },
              contextInfo: contentMsg?.contextInfo,
              messageType: getContentType(received.message),
              messageTimestamp: received.messageTimestamp as number,
              instanceId: this.instanceId,
              source: getDevice(received.key.id),
            };
          }

          if (this.localSettings.readMessages && received.key.id !== 'status@broadcast') {
            await this.client.readMessages([received.key]);
          }

          if (this.localSettings.readStatus && received.key.id === 'status@broadcast') {
            await this.client.readMessages([received.key]);
          }

          this.logger.log(messageRaw);

          this.logger.verbose('Sending data to webhook in event MESSAGES_UPSERT');
          this.sendDataWebhook(Events.MESSAGES_UPSERT, messageRaw);

          if (this.localChatwoot.enabled && !received.key.id.includes('@broadcast')) {
            const chatwootSentMessage = await this.chatwootService.eventWhatsapp(
              Events.MESSAGES_UPSERT,
              { instanceName: this.instance.name },
              messageRaw,
            );

            if (chatwootSentMessage?.id) {
              messageRaw.chatwoot = {
                messageId: chatwootSentMessage.id,
                inboxId: chatwootSentMessage.inbox_id,
                conversationId: chatwootSentMessage.conversation_id,
              };
            }
          }

          const typebotSessionRemoteJid = this.localTypebot.sessions?.find(
            (session) => session.remoteJid === received.key.remoteJid,
          );

          if ((this.localTypebot.enabled && type === 'notify') || typebotSessionRemoteJid) {
            if (!(this.localTypebot.listeningFromMe === false && messageRaw.key.fromMe === true)) {
              if (messageRaw.messageType !== 'reactionMessage')
                await this.typebotService.sendTypebot(
                  { instanceName: this.instance.name },
                  messageRaw.key.remoteJid,
                  messageRaw,
                );
            }
          }

          this.logger.verbose('Inserting message in database');
          await this.prismaRepository.message.create({
            data: messageRaw,
          });

          this.logger.verbose('Verifying contact from message');
          const contact = await this.prismaRepository.contact.findFirst({
            where: { remoteJid: received.key.remoteJid, instanceId: this.instanceId },
          });

          const contactRaw: any = {
            remoteJid: received.key.remoteJid,
            pushName: received.pushName,
            profilePicUrl: (await this.profilePicture(received.key.remoteJid)).profilePictureUrl,
            instanceId: this.instanceId,
          };

          if (contactRaw.id === 'status@broadcast') {
            this.logger.verbose('Contact is status@broadcast');
            return;
          }

          if (contact) {
            this.logger.verbose('Contact found in database');
            const contactRaw: any = {
              remoteJid: received.key.remoteJid,
              pushName: contact.pushName,
              profilePicUrl: (await this.profilePicture(received.key.remoteJid)).profilePictureUrl,
              instanceId: this.instanceId,
            };

            this.logger.verbose('Sending data to webhook in event CONTACTS_UPDATE');
            this.sendDataWebhook(Events.CONTACTS_UPDATE, contactRaw);

            if (this.localChatwoot.enabled) {
              await this.chatwootService.eventWhatsapp(
                Events.CONTACTS_UPDATE,
                { instanceName: this.instance.name },
                contactRaw,
              );
            }

            this.logger.verbose('Updating contact in database');
            this.prismaRepository.contact.updateMany({
              where: { remoteJid: received.key.remoteJid, instanceId: this.instanceId },
              data: contactRaw,
            });
            return;
          }

          this.logger.verbose('Contact not found in database');

          this.logger.verbose('Sending data to webhook in event CONTACTS_UPSERT');
          this.sendDataWebhook(Events.CONTACTS_UPSERT, contactRaw);

          this.logger.verbose('Inserting contact in database');
          await this.prismaRepository.contact.create({
            data: contactRaw,
          });
        }
      } catch (error) {
        this.logger.error(error);
      }
    },

    'messages.update': async (args: WAMessageUpdate[], settings: any) => {
      this.logger.verbose('Event received: messages.update');
      const status: Record<number, wa.StatusMessage> = {
        0: 'ERROR',
        1: 'PENDING',
        2: 'SERVER_ACK',
        3: 'DELIVERY_ACK',
        4: 'READ',
        5: 'PLAYED',
      };
      for await (const { key, update } of args) {
        if (settings?.groupsIgnore && key.remoteJid?.includes('@g.us')) {
          this.logger.verbose('group ignored');
          return;
        }

        if (status[update.status] === 'READ' && key.fromMe) {
          if (this.localChatwoot.enabled) {
            this.chatwootService.eventWhatsapp('messages.read', { instanceName: this.instance.name }, { key: key });
          }
        }

        if (key.remoteJid !== 'status@broadcast') {
          this.logger.verbose('Message update is valid');

          let pollUpdates: any;
          if (update.pollUpdates) {
            this.logger.verbose('Poll update found');

            this.logger.verbose('Getting poll message');
            const pollCreation = await this.getMessage(key);
            this.logger.verbose(pollCreation);

            if (pollCreation) {
              this.logger.verbose('Getting aggregate votes in poll message');
              pollUpdates = getAggregateVotesInPollMessage({
                message: pollCreation as proto.IMessage,
                pollUpdates: update.pollUpdates,
              });
            }
          }

          const findMessage = await this.prismaRepository.message.findFirst({
            where: {
              instanceId: this.instanceId,
              key: {
                path: ['id'],
                equals: key.id,
              },
            },
          });

          if (!findMessage) {
            this.logger.verbose('Message not found in database');
            return;
          }

          if (status[update.status] === 'READ' && !key.fromMe) return;

          if (update.message === null && update.status === undefined) {
            this.logger.verbose('Message deleted');

            this.logger.verbose('Sending data to webhook in event MESSAGE_DELETE');
            this.sendDataWebhook(Events.MESSAGES_DELETE, key);

            const message: any = {
              messageId: findMessage.id,
              keyId: key.id,
              remoteJid: key.remoteJid,
              fromMe: key.fromMe,
              participant: key?.remoteJid,
              status: 'DELETED',
              dateTime: Date.now(),
            };

            this.logger.verbose(message);

            this.logger.verbose('Inserting message in database');
            await this.prismaRepository.messageUpdate.create({
              data: message,
            });

            if (this.localChatwoot.enabled) {
              this.chatwootService.eventWhatsapp(
                Events.MESSAGES_DELETE,
                { instanceName: this.instance.name },
                { key: key },
              );
            }

            return;
          }

          const message: any = {
            messageId: findMessage.id,
            keyId: key.id,
            remoteJid: key.remoteJid,
            fromMe: key.fromMe,
            participant: key?.remoteJid,
            status: status[update.status],
            dateTime: Date.now(),
            pollUpdates,
          };

          this.logger.verbose(message);

          this.logger.verbose('Sending data to webhook in event MESSAGES_UPDATE');
          this.sendDataWebhook(Events.MESSAGES_UPDATE, message);

          this.logger.verbose('Inserting message in database');
          await this.prismaRepository.messageUpdate.create({
            data: message,
          });
        }
      }
    },
  };

  private readonly groupHandler = {
    'groups.upsert': (groupMetadata: GroupMetadata[]) => {
      this.logger.verbose('Event received: groups.upsert');

      this.logger.verbose('Sending data to webhook in event GROUPS_UPSERT');
      this.sendDataWebhook(Events.GROUPS_UPSERT, groupMetadata);
    },

    'groups.update': (groupMetadataUpdate: Partial<GroupMetadata>[]) => {
      this.logger.verbose('Event received: groups.update');

      this.logger.verbose('Sending data to webhook in event GROUPS_UPDATE');
      this.sendDataWebhook(Events.GROUPS_UPDATE, groupMetadataUpdate);

      groupMetadataUpdate.forEach((group) => {
        if (isJidGroup(group.id)) {
          this.updateGroupMetadataCache(group.id);
        }
      });
    },

    'group-participants.update': (participantsUpdate: {
      id: string;
      participants: string[];
      action: ParticipantAction;
    }) => {
      this.logger.verbose('Event received: group-participants.update');

      this.logger.verbose('Sending data to webhook in event GROUP_PARTICIPANTS_UPDATE');
      this.sendDataWebhook(Events.GROUP_PARTICIPANTS_UPDATE, participantsUpdate);
    },
  };

  private readonly labelHandle = {
    [Events.LABELS_EDIT]: async (label: Label) => {
      this.logger.verbose('Event received: labels.edit');
      this.logger.verbose('Finding labels in database');
      const labelsRepository = await this.prismaRepository.label.findMany({
        where: { instanceId: this.instanceId },
      });

      const savedLabel = labelsRepository.find((l) => l.labelId === label.id);
      if (label.deleted && savedLabel) {
        this.logger.verbose('Sending data to webhook in event LABELS_EDIT');
        await this.prismaRepository.label.delete({
          where: { instanceId: this.instanceId, labelId: label.id },
        });
        this.sendDataWebhook(Events.LABELS_EDIT, { ...label, instance: this.instance.name });
        return;
      }

      const labelName = label.name.replace(/[^\x20-\x7E]/g, '');
      if (!savedLabel || savedLabel.color !== `${label.color}` || savedLabel.name !== labelName) {
        this.logger.verbose('Sending data to webhook in event LABELS_EDIT');
        await this.prismaRepository.label.create({
          data: {
            color: `${label.color}`,
            name: labelName,
            labelId: label.id,
            predefinedId: label.predefinedId,
            instanceId: this.instanceId,
          },
        });
        this.sendDataWebhook(Events.LABELS_EDIT, { ...label, instance: this.instance.name });
      }
    },

    [Events.LABELS_ASSOCIATION]: async (
      data: { association: LabelAssociation; type: 'remove' | 'add' },
      database: Database,
    ) => {
      this.logger.verbose('Sending data to webhook in event LABELS_ASSOCIATION');

      // Atualiza labels nos chats
      if (database.ENABLED && database.SAVE_DATA.CHATS) {
        const chats = await this.prismaRepository.chat.findMany({
          where: { instanceId: this.instanceId },
        });
        const chat = chats.find((c) => c.remoteJid === data.association.chatId);
        if (chat) {
          const labelsArray = Array.isArray(chat.labels) ? chat.labels.map((event) => String(event)) : [];
          let labels = [...labelsArray];

          if (data.type === 'remove') {
            labels = labels.filter((label) => label !== data.association.labelId);
          } else if (data.type === 'add') {
            labels = [...labels, data.association.labelId];
          }
          await this.prismaRepository.chat.update({
            where: { id: chat.id },
            data: {
              labels,
            },
          });
        }
      }

      // Envia dados para o webhook
      this.sendDataWebhook(Events.LABELS_ASSOCIATION, {
        instance: this.instance.name,
        type: data.type,
        chatId: data.association.chatId,
        labelId: data.association.labelId,
      });
    },
  };

  private eventHandler() {
    this.logger.verbose('Initializing event handler');
    this.client.ev.process(async (events) => {
      if (!this.endSession) {
        this.logger.verbose(`Event received: ${Object.keys(events).join(', ')}`);
        const database = this.configService.get<Database>('DATABASE');
        const settings = await this.findSettings();

        if (events.call) {
          this.logger.verbose('Listening event: call');
          const call = events.call[0];

          if (settings?.rejectCall && call.status == 'offer') {
            this.logger.verbose('Rejecting call');
            this.client.rejectCall(call.id, call.from);
          }

          if (settings?.msgCall?.trim().length > 0 && call.status == 'offer') {
            this.logger.verbose('Sending message in call');
            const msg = await this.client.sendMessage(call.from, {
              text: settings.msgCall,
            });

            this.logger.verbose('Sending data to event messages.upsert');
            this.client.ev.emit('messages.upsert', {
              messages: [msg],
              type: 'notify',
            });
          }

          this.logger.verbose('Sending data to webhook in event CALL');
          this.sendDataWebhook(Events.CALL, call);
        }

        if (events['connection.update']) {
          this.logger.verbose('Listening event: connection.update');
          this.connectionUpdate(events['connection.update']);
        }

        if (events['creds.update']) {
          this.logger.verbose('Listening event: creds.update');
          this.instance.authState.saveCreds();
        }

        if (events['messaging-history.set']) {
          this.logger.verbose('Listening event: messaging-history.set');
          const payload = events['messaging-history.set'];
          this.messageHandle['messaging-history.set'](payload);
        }

        if (events['messages.upsert']) {
          this.logger.verbose('Listening event: messages.upsert');
          const payload = events['messages.upsert'];
          this.messageHandle['messages.upsert'](payload, settings);
        }

        if (events['messages.update']) {
          this.logger.verbose('Listening event: messages.update');
          const payload = events['messages.update'];
          this.messageHandle['messages.update'](payload, settings);
        }

        if (events['presence.update']) {
          this.logger.verbose('Listening event: presence.update');
          const payload = events['presence.update'];

          if (settings.groupsIgnore && payload.id.includes('@g.us')) {
            this.logger.verbose('group ignored');
            return;
          }
          this.sendDataWebhook(Events.PRESENCE_UPDATE, payload);
        }

        if (!settings?.groupsIgnore) {
          if (events['groups.upsert']) {
            this.logger.verbose('Listening event: groups.upsert');
            const payload = events['groups.upsert'];
            this.groupHandler['groups.upsert'](payload);
          }

          if (events['groups.update']) {
            this.logger.verbose('Listening event: groups.update');
            const payload = events['groups.update'];
            this.groupHandler['groups.update'](payload);
          }

          if (events['group-participants.update']) {
            this.logger.verbose('Listening event: group-participants.update');
            const payload = events['group-participants.update'];
            this.groupHandler['group-participants.update'](payload);
          }
        }

        if (events['chats.upsert']) {
          this.logger.verbose('Listening event: chats.upsert');
          const payload = events['chats.upsert'];
          this.chatHandle['chats.upsert'](payload);
        }

        if (events['chats.update']) {
          this.logger.verbose('Listening event: chats.update');
          const payload = events['chats.update'];
          this.chatHandle['chats.update'](payload);
        }

        if (events['chats.delete']) {
          this.logger.verbose('Listening event: chats.delete');
          const payload = events['chats.delete'];
          this.chatHandle['chats.delete'](payload);
        }

        if (events['contacts.upsert']) {
          this.logger.verbose('Listening event: contacts.upsert');
          const payload = events['contacts.upsert'];
          this.contactHandle['contacts.upsert'](payload);
        }

        if (events['contacts.update']) {
          this.logger.verbose('Listening event: contacts.update');
          const payload = events['contacts.update'];
          this.contactHandle['contacts.update'](payload);
        }

        if (events[Events.LABELS_ASSOCIATION]) {
          this.logger.verbose('Listening event: labels.association');
          const payload = events[Events.LABELS_ASSOCIATION];
          this.labelHandle[Events.LABELS_ASSOCIATION](payload, database);
          return;
        }

        if (events[Events.LABELS_EDIT]) {
          this.logger.verbose('Listening event: labels.edit');
          const payload = events[Events.LABELS_EDIT];
          this.labelHandle[Events.LABELS_EDIT](payload);
          return;
        }
      }
    });
  }

  private historySyncNotification(msg: proto.Message.IHistorySyncNotification) {
    const instance: InstanceDto = { instanceName: this.instance.name };

    if (
      this.localChatwoot.enabled &&
      this.localChatwoot.importMessages &&
      this.isSyncNotificationFromUsedSyncType(msg)
    ) {
      if (msg.chunkOrder === 1) {
        this.chatwootService.startImportHistoryMessages(instance);
      }

      if (msg.progress === 100) {
        setTimeout(() => {
          this.chatwootService.importHistoryMessages(instance);
        }, 10000);
      }
    }

    return true;
  }

  private isSyncNotificationFromUsedSyncType(msg: proto.Message.IHistorySyncNotification) {
    return (
      (this.localSettings.syncFullHistory && msg?.syncType === 2) ||
      (!this.localSettings.syncFullHistory && msg?.syncType === 3)
    );
  }

  public async profilePicture(number: string) {
    const jid = this.createJid(number);

    this.logger.verbose('Getting profile picture with jid: ' + jid);
    try {
      this.logger.verbose('Getting profile picture url');
      return {
        wuid: jid,
        profilePictureUrl: await this.client.profilePictureUrl(jid, 'image'),
      };
    } catch (error) {
      this.logger.verbose('Profile picture not found');
      return {
        wuid: jid,
        profilePictureUrl: null,
      };
    }
  }

  public async getStatus(number: string) {
    const jid = this.createJid(number);

    this.logger.verbose('Getting profile status with jid:' + jid);
    try {
      this.logger.verbose('Getting status');
      return {
        wuid: jid,
        status: (await this.client.fetchStatus(jid))?.status,
      };
    } catch (error) {
      this.logger.verbose('Status not found');
      return {
        wuid: jid,
        status: null,
      };
    }
  }

  public async fetchProfile(instanceName: string, number?: string) {
    const jid = number ? this.createJid(number) : this.client?.user?.id;

    const onWhatsapp = (await this.whatsappNumber({ numbers: [jid] }))?.shift();

    if (!onWhatsapp.exists) {
      throw new BadRequestException(onWhatsapp);
    }

    this.logger.verbose('Getting profile with jid: ' + jid);
    try {
      this.logger.verbose('Getting profile info');

      if (number) {
        const info = (await this.whatsappNumber({ numbers: [jid] }))?.shift();
        const picture = await this.profilePicture(info?.jid);
        const status = await this.getStatus(info?.jid);
        const business = await this.fetchBusinessProfile(info?.jid);

        return {
          wuid: info?.jid || jid,
          name: info?.name,
          numberExists: info?.exists,
          picture: picture?.profilePictureUrl,
          status: status?.status,
          isBusiness: business.isBusiness,
          email: business?.email,
          description: business?.description,
          website: business?.website?.shift(),
        };
      } else {
        const info = await waMonitor.instanceInfo(instanceName);
        const business = await this.fetchBusinessProfile(jid);

        return {
          wuid: jid,
          name: info?.instance?.profileName,
          numberExists: true,
          picture: info?.instance?.profilePictureUrl,
          status: info?.instance?.profileStatus,
          isBusiness: business.isBusiness,
          email: business?.email,
          description: business?.description,
          website: business?.website?.shift(),
        };
      }
    } catch (error) {
      this.logger.verbose('Profile not found');
      return {
        wuid: jid,
        name: null,
        picture: null,
        status: null,
        os: null,
        isBusiness: false,
      };
    }
  }

  private async sendMessageWithTyping<T = proto.IMessage>(
    number: string,
    message: T,
    options?: Options,
    isChatwoot = false,
  ) {
    this.logger.verbose('Sending message with typing');

    this.logger.verbose(`Check if number "${number}" is WhatsApp`);
    const isWA = (await this.whatsappNumber({ numbers: [number] }))?.shift();

    this.logger.verbose(`Exists: "${isWA.exists}" | jid: ${isWA.jid}`);

    if (!isWA.exists && !isJidGroup(isWA.jid) && !isWA.jid.includes('@broadcast')) {
      if (this.localChatwoot.enabled) {
        const body = {
          key: { remoteJid: isWA.jid },
        };

        this.chatwootService.eventWhatsapp('contact.is_not_in_wpp', { instanceName: this.instance.name }, body);
      }
      throw new BadRequestException(isWA);
    }

    const sender = isWA.jid;

    try {
      if (options?.delay) {
        this.logger.verbose('Delaying message');

        if (options.delay > 20000) {
          let remainingDelay = options.delay;
          while (remainingDelay > 20000) {
            await this.client.presenceSubscribe(sender);

            await this.client.sendPresenceUpdate((options.presence as WAPresence) ?? 'composing', sender);

            await delay(20000);

            await this.client.sendPresenceUpdate('paused', sender);

            remainingDelay -= 20000;
          }
          if (remainingDelay > 0) {
            await this.client.presenceSubscribe(sender);

            await this.client.sendPresenceUpdate((options.presence as WAPresence) ?? 'composing', sender);

            await delay(remainingDelay);

            await this.client.sendPresenceUpdate('paused', sender);
          }
        } else {
          await this.client.presenceSubscribe(sender);

          await this.client.sendPresenceUpdate((options.presence as WAPresence) ?? 'composing', sender);

          await delay(options.delay);

          await this.client.sendPresenceUpdate('paused', sender);
        }
      }

      const linkPreview = options?.linkPreview != false ? undefined : false;

      let quoted: WAMessage;

      if (options?.quoted) {
        const m = options?.quoted;

        const msg = m?.message ? m : ((await this.getMessage(m.key, true)) as proto.IWebMessageInfo);

        if (msg) {
          quoted = msg;
          this.logger.verbose('Quoted message');
        }
      }

      let mentions: string[];
      if (isJidGroup(sender)) {
        try {
          let group;

          const cache = this.configService.get<CacheConf>('CACHE');
          if (!cache.REDIS.ENABLED && !cache.LOCAL.ENABLED) group = await this.findGroup({ groupJid: sender }, 'inner');
          else group = await this.getGroupMetadataCache(sender);

          if (!group) {
            throw new NotFoundException('Group not found');
          }

          if (options?.mentions) {
            this.logger.verbose('Mentions defined');

            if (options.mentions?.everyOne) {
              this.logger.verbose('Mentions everyone');

              this.logger.verbose('Getting group metadata');
              mentions = group.participants.map((participant) => participant.id);
              this.logger.verbose('Getting group metadata for mentions');
            } else if (options.mentions?.mentioned?.length) {
              this.logger.verbose('Mentions manually defined');
              mentions = options.mentions.mentioned.map((mention) => {
                const jid = this.createJid(mention);
                if (isJidGroup(jid)) {
                  return null;
                }
                return jid;
              });
            }
          }
        } catch (error) {
          throw new NotFoundException('Group not found');
        }
      }

      const messageSent = await (async () => {
        const option = {
          quoted,
        };

        if (
          !message['audio'] &&
          !message['poll'] &&
          !message['sticker'] &&
          !message['conversation'] &&
          sender !== 'status@broadcast'
        ) {
          if (message['reactionMessage']) {
            this.logger.verbose('Sending reaction');
            return await this.client.sendMessage(
              sender,
              {
                react: {
                  text: message['reactionMessage']['text'],
                  key: message['reactionMessage']['key'],
                },
              } as unknown as AnyMessageContent,
              {
                ...option,
                cachedGroupMetadata:
                  !this.configService.get<CacheConf>('CACHE').REDIS.ENABLED &&
                  !this.configService.get<CacheConf>('CACHE').LOCAL.ENABLED
                    ? null
                    : this.getGroupMetadataCache,
              } as unknown as MiscMessageGenerationOptions,
            );
          }
        }
        if (message['conversation']) {
          this.logger.verbose('Sending message');
          return await this.client.sendMessage(
            sender,
            {
              text: message['conversation'],
              mentions,
              linkPreview: linkPreview,
            } as unknown as AnyMessageContent,
            {
              ...option,
              cachedGroupMetadata:
                !this.configService.get<CacheConf>('CACHE').REDIS.ENABLED &&
                !this.configService.get<CacheConf>('CACHE').LOCAL.ENABLED
                  ? null
                  : this.getGroupMetadataCache,
            } as unknown as MiscMessageGenerationOptions,
          );
        }

        if (!message['audio'] && !message['poll'] && sender != 'status@broadcast') {
          this.logger.verbose('Sending message');
          return await this.client.sendMessage(
            sender,
            {
              forward: {
                key: { remoteJid: this.instance.wuid, fromMe: true },
                message,
              },
              mentions,
            },
            {
              ...option,
              cachedGroupMetadata:
                !this.configService.get<CacheConf>('CACHE').REDIS.ENABLED &&
                !this.configService.get<CacheConf>('CACHE').LOCAL.ENABLED
                  ? null
                  : this.getGroupMetadataCache,
            } as unknown as MiscMessageGenerationOptions,
          );
        }

        if (sender === 'status@broadcast') {
          this.logger.verbose('Sending message');
          return await this.client.sendMessage(
            sender,
            message['status'].content as unknown as AnyMessageContent,
            {
              backgroundColor: message['status'].option.backgroundColor,
              font: message['status'].option.font,
              statusJidList: message['status'].option.statusJidList,
            } as unknown as MiscMessageGenerationOptions,
          );
        }

        this.logger.verbose('Sending message');
        return await this.client.sendMessage(
          sender,
          message as unknown as AnyMessageContent,
          {
            ...option,
            cachedGroupMetadata:
              !this.configService.get<CacheConf>('CACHE').REDIS.ENABLED &&
              !this.configService.get<CacheConf>('CACHE').LOCAL.ENABLED
                ? null
                : this.getGroupMetadataCache,
          } as unknown as MiscMessageGenerationOptions,
        );
      })();

      const contentMsg = messageSent.message[getContentType(messageSent.message)] as any;

      const messageRaw: any = {
        key: messageSent.key,
        pushName: messageSent.pushName,
        message: { ...messageSent.message },
        contextInfo: contentMsg?.contextInfo,
        messageType: getContentType(messageSent.message),
        messageTimestamp: Long.fromValue(messageSent.messageTimestamp).toString(),
        instanceId: this.instanceId,
        source: getDevice(messageSent.key.id),
      };

      this.logger.log(messageRaw);

      this.logger.verbose('Sending data to webhook in event SEND_MESSAGE');
      this.sendDataWebhook(Events.SEND_MESSAGE, messageRaw);

      if (this.localChatwoot.enabled && !isChatwoot) {
        this.chatwootService.eventWhatsapp(Events.SEND_MESSAGE, { instanceName: this.instance.name }, messageRaw);
      }

      this.logger.verbose('Inserting message in database');
      await this.prismaRepository.message.create({
        data: messageRaw,
      });

      return messageSent;
    } catch (error) {
      this.logger.error(error);
      throw new BadRequestException(error.toString());
    }
  }

  // Instance Controller
  public async sendPresence(data: SendPresenceDto) {
    try {
      const { number } = data;

      this.logger.verbose(`Check if number "${number}" is WhatsApp`);
      const isWA = (await this.whatsappNumber({ numbers: [number] }))?.shift();

      this.logger.verbose(`Exists: "${isWA.exists}" | jid: ${isWA.jid}`);
      if (!isWA.exists && !isJidGroup(isWA.jid) && !isWA.jid.includes('@broadcast')) {
        throw new BadRequestException(isWA);
      }

      const sender = isWA.jid;

      if (data?.options?.delay && data?.options?.delay > 20000) {
        let remainingDelay = data?.options.delay;
        while (remainingDelay > 20000) {
          await this.client.presenceSubscribe(sender);

          await this.client.sendPresenceUpdate((data?.options?.presence as WAPresence) ?? 'composing', sender);

          await delay(20000);

          await this.client.sendPresenceUpdate('paused', sender);

          remainingDelay -= 20000;
        }
        if (remainingDelay > 0) {
          await this.client.presenceSubscribe(sender);

          await this.client.sendPresenceUpdate((data?.options?.presence as WAPresence) ?? 'composing', sender);

          await delay(remainingDelay);

          await this.client.sendPresenceUpdate('paused', sender);
        }
      } else {
        await this.client.presenceSubscribe(sender);

        await this.client.sendPresenceUpdate((data?.options?.presence as WAPresence) ?? 'composing', sender);

        await delay(data?.options?.delay);

        await this.client.sendPresenceUpdate('paused', sender);
      }
    } catch (error) {
      this.logger.error(error);
      throw new BadRequestException(error.toString());
    }
  }

  // Presence Controller
  public async setPresence(data: SetPresenceDto) {
    try {
      await this.client.sendPresenceUpdate(data.presence);
      this.logger.verbose('Sending presence update: ' + data.presence);
    } catch (error) {
      this.logger.error(error);
      throw new BadRequestException(error.toString());
    }
  }

  // Send Message Controller
  public async textMessage(data: SendTextDto, isChatwoot = false) {
    this.logger.verbose('Sending text message');
    return await this.sendMessageWithTyping(
      data.number,
      {
        conversation: data.textMessage.text,
      },
      data?.options,
      isChatwoot,
    );
  }

  public async pollMessage(data: SendPollDto) {
    this.logger.verbose('Sending poll message');
    return await this.sendMessageWithTyping(
      data.number,
      {
        poll: {
          name: data.pollMessage.name,
          selectableCount: data.pollMessage.selectableCount,
          values: data.pollMessage.values,
        },
      },
      data?.options,
    );
  }

  private async formatStatusMessage(status: StatusMessage) {
    this.logger.verbose('Formatting status message');

    if (!status.type) {
      throw new BadRequestException('Type is required');
    }

    if (!status.content) {
      throw new BadRequestException('Content is required');
    }

    if (status.allContacts) {
      this.logger.verbose('All contacts defined as true');

      this.logger.verbose('Getting contacts from database');
      const contacts = await this.prismaRepository.contact.findMany({
        where: { instanceId: this.instanceId },
      });

      if (!contacts.length) {
        throw new BadRequestException('Contacts not found');
      }

      this.logger.verbose('Getting contacts with push name');
      status.statusJidList = contacts.filter((contact) => contact.pushName).map((contact) => contact.remoteJid);

      this.logger.verbose(status.statusJidList);
    }

    if (!status.statusJidList?.length && !status.allContacts) {
      throw new BadRequestException('StatusJidList is required');
    }

    if (status.type === 'text') {
      this.logger.verbose('Type defined as text');

      if (!status.backgroundColor) {
        throw new BadRequestException('Background color is required');
      }

      if (!status.font) {
        throw new BadRequestException('Font is required');
      }

      return {
        content: {
          text: status.content,
        },
        option: {
          backgroundColor: status.backgroundColor,
          font: status.font,
          statusJidList: status.statusJidList,
        },
      };
    }
    if (status.type === 'image') {
      this.logger.verbose('Type defined as image');

      return {
        content: {
          image: {
            url: status.content,
          },
          caption: status.caption,
        },
        option: {
          statusJidList: status.statusJidList,
        },
      };
    }
    if (status.type === 'video') {
      this.logger.verbose('Type defined as video');

      return {
        content: {
          video: {
            url: status.content,
          },
          caption: status.caption,
        },
        option: {
          statusJidList: status.statusJidList,
        },
      };
    }
    if (status.type === 'audio') {
      this.logger.verbose('Type defined as audio');

      this.logger.verbose('Processing audio');
      const convert = await this.processAudio(status.content, 'status@broadcast');
      if (typeof convert === 'string') {
        this.logger.verbose('Audio processed');
        const audio = fs.readFileSync(convert).toString('base64');

        const result = {
          content: {
            audio: Buffer.from(audio, 'base64'),
            ptt: true,
            mimetype: 'audio/mp4',
          },
          option: {
            statusJidList: status.statusJidList,
          },
        };

        fs.unlinkSync(convert);

        return result;
      } else {
        throw new InternalServerErrorException(convert);
      }
    }

    throw new BadRequestException('Type not found');
  }

  public async statusMessage(data: SendStatusDto) {
    this.logger.verbose('Sending status message');
    const status = await this.formatStatusMessage(data.statusMessage);

    return await this.sendMessageWithTyping('status@broadcast', {
      status,
    });
  }

  private async prepareMediaMessage(mediaMessage: MediaMessage) {
    try {
      this.logger.verbose('Preparing media message');
      const prepareMedia = await prepareWAMessageMedia(
        {
          [mediaMessage.mediatype]: isURL(mediaMessage.media)
            ? { url: mediaMessage.media }
            : Buffer.from(mediaMessage.media, 'base64'),
        } as any,
        { upload: this.client.waUploadToServer },
      );

      const mediaType = mediaMessage.mediatype + 'Message';
      this.logger.verbose('Media type: ' + mediaType);

      if (mediaMessage.mediatype === 'document' && !mediaMessage.fileName) {
        this.logger.verbose('If media type is document and file name is not defined then');
        const regex = new RegExp(/.*\/(.+?)\./);
        const arrayMatch = regex.exec(mediaMessage.media);
        mediaMessage.fileName = arrayMatch[1];
        this.logger.verbose('File name: ' + mediaMessage.fileName);
      }

      if (mediaMessage.mediatype === 'image' && !mediaMessage.fileName) {
        mediaMessage.fileName = 'image.png';
      }

      if (mediaMessage.mediatype === 'video' && !mediaMessage.fileName) {
        mediaMessage.fileName = 'video.mp4';
      }

      let mimetype: string;

      if (mediaMessage.mimetype) {
        mimetype = mediaMessage.mimetype;
      } else {
        mimetype = getMIMEType(mediaMessage.fileName);

        if (!mimetype && isURL(mediaMessage.media)) {
          let config: any = {
            responseType: 'arraybuffer',
          };

          if (this.localProxy.enabled) {
            config = {
              ...config,
              httpsAgent: makeProxyAgent(this.localProxy.proxy),
            };
          }

          const response = await axios.get(mediaMessage.media, config);

          mimetype = response.headers['content-type'];
        }
      }

      this.logger.verbose('Mimetype: ' + mimetype);

      prepareMedia[mediaType].caption = mediaMessage?.caption;
      prepareMedia[mediaType].mimetype = mimetype;
      prepareMedia[mediaType].fileName = mediaMessage.fileName;

      if (mediaMessage.mediatype === 'video') {
        this.logger.verbose('Is media type video then set gif playback as false');
        prepareMedia[mediaType].jpegThumbnail = Uint8Array.from(
          readFileSync(join(process.cwd(), 'public', 'images', 'video-cover.png')),
        );
        prepareMedia[mediaType].gifPlayback = false;
      }

      this.logger.verbose('Generating wa message from content');
      return generateWAMessageFromContent(
        '',
        { [mediaType]: { ...prepareMedia[mediaType] } },
        { userJid: this.instance.wuid },
      );
    } catch (error) {
      this.logger.error(error);
      throw new InternalServerErrorException(error?.toString() || error);
    }
  }

  private async convertToWebP(image: string, number: string) {
    try {
      this.logger.verbose('Converting image to WebP to sticker');

      let imagePath: string;
      const hash = `${number}-${new Date().getTime()}`;
      this.logger.verbose('Hash to image name: ' + hash);

      const outputPath = `${join(this.storePath, 'temp', `${hash}.webp`)}`;
      this.logger.verbose('Output path: ' + outputPath);

      if (isBase64(image)) {
        this.logger.verbose('Image is base64');

        const base64Data = image.replace(/^data:image\/(jpeg|png|gif);base64,/, '');
        const imageBuffer = Buffer.from(base64Data, 'base64');
        imagePath = `${join(this.storePath, 'temp', `temp-${hash}.png`)}`;
        this.logger.verbose('Image path: ' + imagePath);

        await sharp(imageBuffer).toFile(imagePath);
        this.logger.verbose('Image created');
      } else {
        this.logger.verbose('Image is url');

        const timestamp = new Date().getTime();
        const url = `${image}?timestamp=${timestamp}`;
        this.logger.verbose('including timestamp in url: ' + url);

        let config: any = {
          responseType: 'arraybuffer',
        };

        if (this.localProxy.enabled) {
          config = {
            ...config,
            httpsAgent: makeProxyAgent(this.localProxy.proxy),
          };
        }

        const response = await axios.get(url, config);
        this.logger.verbose('Getting image from url');

        const imageBuffer = Buffer.from(response.data, 'binary');
        imagePath = `${join(this.storePath, 'temp', `temp-${hash}.png`)}`;
        this.logger.verbose('Image path: ' + imagePath);

        await sharp(imageBuffer).toFile(imagePath);
        this.logger.verbose('Image created');
      }

      await sharp(imagePath).webp().toFile(outputPath);
      this.logger.verbose('Image converted to WebP');

      fs.unlinkSync(imagePath);
      this.logger.verbose('Temp image deleted');

      return outputPath;
    } catch (error) {
      console.error('Erro ao converter a imagem para WebP:', error);
    }
  }

  public async mediaSticker(data: SendStickerDto) {
    this.logger.verbose('Sending media sticker');
    const convert = await this.convertToWebP(data.stickerMessage.image, data.number);
    const result = await this.sendMessageWithTyping(
      data.number,
      {
        sticker: { url: convert },
      },
      data?.options,
    );

    fs.unlinkSync(convert);
    this.logger.verbose('Converted image deleted');

    return result;
  }

  public async mediaMessage(data: SendMediaDto, isChatwoot = false) {
    this.logger.verbose('Sending media message');
    const generate = await this.prepareMediaMessage(data.mediaMessage);

    return await this.sendMessageWithTyping(data.number, { ...generate.message }, data?.options, isChatwoot);
  }

  public async processAudio(audio: string, number: string) {
    this.logger.verbose('Processing audio');
    let tempAudioPath: string;
    let outputAudio: string;

    number = number.replace(/\D/g, '');
    const hash = `${number}-${new Date().getTime()}`;
    this.logger.verbose('Hash to audio name: ' + hash);

    if (isURL(audio)) {
      this.logger.verbose('Audio is url');

      outputAudio = `${join(this.storePath, 'temp', `${hash}.mp4`)}`;
      tempAudioPath = `${join(this.storePath, 'temp', `temp-${hash}.mp3`)}`;

      this.logger.verbose('Output audio path: ' + outputAudio);
      this.logger.verbose('Temp audio path: ' + tempAudioPath);

      const timestamp = new Date().getTime();
      const url = `${audio}?timestamp=${timestamp}`;

      this.logger.verbose('Including timestamp in url: ' + url);

      const response = await axios.get(url, { responseType: 'arraybuffer' });
      this.logger.verbose('Getting audio from url');

      fs.writeFileSync(tempAudioPath, response.data);
    } else {
      this.logger.verbose('Audio is base64');

      outputAudio = `${join(this.storePath, 'temp', `${hash}.mp4`)}`;
      tempAudioPath = `${join(this.storePath, 'temp', `temp-${hash}.mp3`)}`;

      this.logger.verbose('Output audio path: ' + outputAudio);
      this.logger.verbose('Temp audio path: ' + tempAudioPath);

      const audioBuffer = Buffer.from(audio, 'base64');
      fs.writeFileSync(tempAudioPath, audioBuffer);
      this.logger.verbose('Temp audio created');
    }

    this.logger.verbose('Converting audio to mp4');
    return new Promise((resolve, reject) => {
      exec(`${ffmpegPath.path} -i ${tempAudioPath} -vn -ab 128k -ar 44100 -f ipod ${outputAudio} -y`, (error) => {
        fs.unlinkSync(tempAudioPath);
        this.logger.verbose('Temp audio deleted');

        if (error) reject(error);

        this.logger.verbose('Audio converted to mp4');
        resolve(outputAudio);
      });
    });
  }

  public async audioWhatsapp(data: SendAudioDto, isChatwoot = false) {
    this.logger.verbose('Sending audio whatsapp');

    if (!data.options?.encoding && data.options?.encoding !== false) {
      data.options.encoding = true;
    }

    if (data.options?.encoding) {
      const convert = await this.processAudio(data.audioMessage.audio, data.number);
      if (typeof convert === 'string') {
        const audio = fs.readFileSync(convert).toString('base64');
        const result = this.sendMessageWithTyping<AnyMessageContent>(
          data.number,
          {
            audio: Buffer.from(audio, 'base64'),
            ptt: true,
            mimetype: 'audio/mp4',
          },
          { presence: 'recording', delay: data?.options?.delay },
          isChatwoot,
        );

        fs.unlinkSync(convert);
        this.logger.verbose('Converted audio deleted');

        return result;
      } else {
        throw new InternalServerErrorException(convert);
      }
    }

    return await this.sendMessageWithTyping<AnyMessageContent>(
      data.number,
      {
        audio: isURL(data.audioMessage.audio)
          ? { url: data.audioMessage.audio }
          : Buffer.from(data.audioMessage.audio, 'base64'),
        ptt: true,
        mimetype: 'audio/ogg; codecs=opus',
      },
      { presence: 'recording', delay: data?.options?.delay },
      isChatwoot,
    );
  }

  public async buttonMessage() {
    throw new BadRequestException('Method not available on WhatsApp Baileys');
  }

  public async locationMessage(data: SendLocationDto) {
    this.logger.verbose('Sending location message');
    return await this.sendMessageWithTyping(
      data.number,
      {
        locationMessage: {
          degreesLatitude: data.locationMessage.latitude,
          degreesLongitude: data.locationMessage.longitude,
          name: data.locationMessage?.name,
          address: data.locationMessage?.address,
        },
      },
      data?.options,
    );
  }

  public async listMessage(data: SendListDto) {
    this.logger.verbose('Sending list message');
    return await this.sendMessageWithTyping(
      data.number,
      {
        listMessage: {
          title: data.listMessage.title,
          description: data.listMessage.description,
          buttonText: data.listMessage?.buttonText,
          footerText: data.listMessage?.footerText,
          sections: data.listMessage.sections,
          listType: 2,
        },
      },
      data?.options,
    );
  }

  public async contactMessage(data: SendContactDto) {
    this.logger.verbose('Sending contact message');
    const message: proto.IMessage = {};

    const vcard = (contact: ContactMessage) => {
      this.logger.verbose('Creating vcard');
      let result = 'BEGIN:VCARD\n' + 'VERSION:3.0\n' + `N:${contact.fullName}\n` + `FN:${contact.fullName}\n`;

      if (contact.organization) {
        this.logger.verbose('Organization defined');
        result += `ORG:${contact.organization};\n`;
      }

      if (contact.email) {
        this.logger.verbose('Email defined');
        result += `EMAIL:${contact.email}\n`;
      }

      if (contact.url) {
        this.logger.verbose('Url defined');
        result += `URL:${contact.url}\n`;
      }

      if (!contact.wuid) {
        this.logger.verbose('Wuid defined');
        contact.wuid = this.createJid(contact.phoneNumber);
      }

      result += `item1.TEL;waid=${contact.wuid}:${contact.phoneNumber}\n` + 'item1.X-ABLabel:Celular\n' + 'END:VCARD';

      this.logger.verbose('Vcard created');
      return result;
    };

    if (data.contactMessage.length === 1) {
      message.contactMessage = {
        displayName: data.contactMessage[0].fullName,
        vcard: vcard(data.contactMessage[0]),
      };
    } else {
      message.contactsArrayMessage = {
        displayName: `${data.contactMessage.length} contacts`,
        contacts: data.contactMessage.map((contact) => {
          return {
            displayName: contact.fullName,
            vcard: vcard(contact),
          };
        }),
      };
    }

    return await this.sendMessageWithTyping(data.number, { ...message }, data?.options);
  }

  public async reactionMessage(data: SendReactionDto) {
    this.logger.verbose('Sending reaction message');
    return await this.sendMessageWithTyping(data.reactionMessage.key.remoteJid, {
      reactionMessage: {
        key: data.reactionMessage.key,
        text: data.reactionMessage.reaction,
      },
    });
  }

  // Chat Controller
  public async whatsappNumber(data: WhatsAppNumberDto) {
    this.logger.verbose('Getting whatsapp number');

    const jids: {
      groups: { number: string; jid: string }[];
      broadcast: { number: string; jid: string }[];
      users: { number: string; jid: string; name?: string }[];
    } = {
      groups: [],
      broadcast: [],
      users: [],
    };

    data.numbers.forEach((number) => {
      const jid = this.createJid(number);

      if (isJidGroup(jid)) {
        jids.groups.push({ number, jid });
      } else if (jid === 'status@broadcast') {
        jids.broadcast.push({ number, jid });
      } else {
        jids.users.push({ number, jid });
      }
    });

    const onWhatsapp: OnWhatsAppDto[] = [];

    // BROADCAST
    onWhatsapp.push(...jids.broadcast.map(({ jid, number }) => new OnWhatsAppDto(jid, false, number)));

    // GROUPS
    const groups = await Promise.all(
      jids.groups.map(async ({ jid, number }) => {
        const group = await this.findGroup({ groupJid: jid }, 'inner');

        if (!group) {
          new OnWhatsAppDto(jid, false, number);
        }

        return new OnWhatsAppDto(group.id, !!group?.id, number, group?.subject);
      }),
    );
    onWhatsapp.push(...groups);

    // USERS
    const contacts: any[] = await this.prismaRepository.contact.findMany({
      where: {
        instanceId: this.instanceId,
        remoteJid: {
          in: jids.users.map(({ jid }) => jid),
        },
      },
    });

    const numbersToVerify = jids.users.map(({ jid }) => jid.replace('+', ''));
    const verify = await this.client.onWhatsApp(...numbersToVerify);
    const users: OnWhatsAppDto[] = await Promise.all(
      jids.users.map(async (user) => {
        let numberVerified: (typeof verify)[0] | null = null;

        // Brazilian numbers
        if (user.number.startsWith('55')) {
          const numberWithDigit =
            user.number.slice(4, 5) === '9' && user.number.length === 13
              ? user.number
              : `${user.number.slice(0, 4)}9${user.number.slice(4)}`;
          const numberWithoutDigit =
            user.number.length === 12 ? user.number : user.number.slice(0, 4) + user.number.slice(5);

          numberVerified = verify.find(
            (v) => v.jid === `${numberWithDigit}@s.whatsapp.net` || v.jid === `${numberWithoutDigit}@s.whatsapp.net`,
          );
        }

        // Mexican/Argentina numbers
        // Ref: https://faq.whatsapp.com/1294841057948784
        if (!numberVerified && (user.number.startsWith('52') || user.number.startsWith('54'))) {
          let prefix = '';
          if (user.number.startsWith('52')) {
            prefix = '1';
          }
          if (user.number.startsWith('54')) {
            prefix = '9';
          }

          const numberWithDigit =
            user.number.slice(2, 3) === prefix && user.number.length === 13
              ? user.number
              : `${user.number.slice(0, 2)}${prefix}${user.number.slice(2)}`;
          const numberWithoutDigit =
            user.number.length === 12 ? user.number : user.number.slice(0, 2) + user.number.slice(3);

          numberVerified = verify.find(
            (v) => v.jid === `${numberWithDigit}@s.whatsapp.net` || v.jid === `${numberWithoutDigit}@s.whatsapp.net`,
          );
        }

        if (!numberVerified) {
          numberVerified = verify.find((v) => v.jid === user.jid);
        }

        const numberJid = numberVerified?.jid || user.jid;
        return {
          exists: !!numberVerified?.exists,
          jid: numberJid,
          name: contacts.find((c) => c.id === numberJid)?.pushName,
          number: user.number,
        };
      }),
    );

    onWhatsapp.push(...users);

    return onWhatsapp;
  }

  public async markMessageAsRead(data: ReadMessageDto) {
    this.logger.verbose('Marking message as read');

    try {
      const keys: proto.IMessageKey[] = [];
      data.read_messages.forEach((read) => {
        if (isJidGroup(read.remoteJid) || isJidUser(read.remoteJid)) {
          keys.push({
            remoteJid: read.remoteJid,
            fromMe: read.fromMe,
            id: read.id,
          });
        }
      });
      await this.client.readMessages(keys);
      return { message: 'Read messages', read: 'success' };
    } catch (error) {
      throw new InternalServerErrorException('Read messages fail', error.toString());
    }
  }

  public async getLastMessage(number: string) {
    const messages = await this.fetchMessages({
      where: {
        key: {
          remoteJid: number,
        },
        owner: this.instance.name,
      },
    });

    let lastMessage = messages.pop();

    for (const message of messages) {
      if (message.messageTimestamp >= lastMessage.messageTimestamp) {
        lastMessage = message;
      }
    }

    return lastMessage as unknown as LastMessage;
  }

  public async archiveChat(data: ArchiveChatDto) {
    this.logger.verbose('Archiving chat');
    try {
      let last_message = data.lastMessage;
      let number = data.chat;

      if (!last_message && number) {
        last_message = await this.getLastMessage(number);
      } else {
        last_message = data.lastMessage;
        last_message.messageTimestamp = last_message?.messageTimestamp ?? Date.now();
        number = last_message?.key?.remoteJid;
      }

      if (!last_message || Object.keys(last_message).length === 0) {
        throw new NotFoundException('Last message not found');
      }

      await this.client.chatModify(
        {
          archive: data.archive,
          lastMessages: [last_message],
        },
        this.createJid(number),
      );

      return {
        chatId: number,
        archived: true,
      };
    } catch (error) {
      throw new InternalServerErrorException({
        archived: false,
        message: ['An error occurred while archiving the chat. Open a calling.', error.toString()],
      });
    }
  }

  public async markChatUnread(data: MarkChatUnreadDto) {
    this.logger.verbose('Marking chat as unread');

    try {
      let last_message = data.lastMessage;
      let number = data.chat;

      if (!last_message && number) {
        last_message = await this.getLastMessage(number);
      } else {
        last_message = data.lastMessage;
        last_message.messageTimestamp = last_message?.messageTimestamp ?? Date.now();
        number = last_message?.key?.remoteJid;
      }

      if (!last_message || Object.keys(last_message).length === 0) {
        throw new NotFoundException('Last message not found');
      }

      await this.client.chatModify(
        {
          markRead: false,
          lastMessages: [last_message],
        },
        this.createJid(number),
      );

      return {
        chatId: number,
        markedChatUnread: true,
      };
    } catch (error) {
      throw new InternalServerErrorException({
        markedChatUnread: false,
        message: ['An error occurred while marked unread the chat. Open a calling.', error.toString()],
      });
    }
  }

  public async deleteMessage(del: DeleteMessage) {
    this.logger.verbose('Deleting message');
    try {
      return await this.client.sendMessage(del.remoteJid, { delete: del });
    } catch (error) {
      throw new InternalServerErrorException('Error while deleting message for everyone', error?.toString());
    }
  }

  public async getBase64FromMediaMessage(data: getBase64FromMediaMessageDto) {
    this.logger.verbose('Getting base64 from media message');
    try {
      const m = data?.message;
      const convertToMp4 = data?.convertToMp4 ?? false;

      const msg = m?.message ? m : ((await this.getMessage(m.key, true)) as proto.IWebMessageInfo);

      if (!msg) {
        throw 'Message not found';
      }

      for (const subtype of MessageSubtype) {
        if (msg.message[subtype]) {
          msg.message = msg.message[subtype].message;
        }
      }

      let mediaMessage: any;
      let mediaType: string;

      for (const type of TypeMediaMessage) {
        mediaMessage = msg.message[type];
        if (mediaMessage) {
          mediaType = type;
          break;
        }
      }

      if (!mediaMessage) {
        throw 'The message is not of the media type';
      }

      if (typeof mediaMessage['mediaKey'] === 'object') {
        msg.message = JSON.parse(JSON.stringify(msg.message));
      }

      this.logger.verbose('Downloading media message');
      const buffer = await downloadMediaMessage(
        { key: msg?.key, message: msg?.message },
        'buffer',
        {},
        {
          logger: P({ level: 'error' }) as any,
          reuploadRequest: this.client.updateMediaMessage,
        },
      );
      const typeMessage = getContentType(msg.message);

      if (convertToMp4 && typeMessage === 'audioMessage') {
        this.logger.verbose('Converting audio to mp4');
        const number = msg.key.remoteJid.split('@')[0];
        const convert = await this.processAudio(buffer.toString('base64'), number);

        if (typeof convert === 'string') {
          const audio = fs.readFileSync(convert).toString('base64');
          this.logger.verbose('Audio converted to mp4');

          const result = {
            mediaType,
            fileName: mediaMessage['fileName'],
            caption: mediaMessage['caption'],
            size: {
              fileLength: mediaMessage['fileLength'],
              height: mediaMessage['height'],
              width: mediaMessage['width'],
            },
            mimetype: 'audio/mp4',
            base64: Buffer.from(audio, 'base64').toString('base64'),
          };

          fs.unlinkSync(convert);
          this.logger.verbose('Converted audio deleted');

          this.logger.verbose('Media message downloaded');
          return result;
        }
      }

      this.logger.verbose('Media message downloaded');
      return {
        mediaType,
        fileName: mediaMessage['fileName'],
        caption: mediaMessage['caption'],
        size: {
          fileLength: mediaMessage['fileLength'],
          height: mediaMessage['height'],
          width: mediaMessage['width'],
        },
        mimetype: mediaMessage['mimetype'],
        base64: buffer.toString('base64'),
      };
    } catch (error) {
      this.logger.error(error);
      throw new BadRequestException(error.toString());
    }
  }

  public async fetchPrivacySettings() {
    this.logger.verbose('Fetching privacy settings');
    const privacy = await this.client.fetchPrivacySettings();

    return {
      readreceipts: privacy.readreceipts,
      profile: privacy.profile,
      status: privacy.status,
      online: privacy.online,
      last: privacy.last,
      groupadd: privacy.groupadd,
    };
  }

  public async updatePrivacySettings(settings: PrivacySettingDto) {
    this.logger.verbose('Updating privacy settings');
    try {
      await this.client.updateReadReceiptsPrivacy(settings.privacySettings.readreceipts);
      this.logger.verbose('Read receipts privacy updated');

      await this.client.updateProfilePicturePrivacy(settings.privacySettings.profile);
      this.logger.verbose('Profile picture privacy updated');

      await this.client.updateStatusPrivacy(settings.privacySettings.status);
      this.logger.verbose('Status privacy updated');

      await this.client.updateOnlinePrivacy(settings.privacySettings.online);
      this.logger.verbose('Online privacy updated');

      await this.client.updateLastSeenPrivacy(settings.privacySettings.last);
      this.logger.verbose('Last seen privacy updated');

      await this.client.updateGroupsAddPrivacy(settings.privacySettings.groupadd);
      this.logger.verbose('Groups add privacy updated');

      this.reloadConnection();

      return {
        update: 'success',
        data: {
          readreceipts: settings.privacySettings.readreceipts,
          profile: settings.privacySettings.profile,
          status: settings.privacySettings.status,
          online: settings.privacySettings.online,
          last: settings.privacySettings.last,
          groupadd: settings.privacySettings.groupadd,
        },
      };
    } catch (error) {
      throw new InternalServerErrorException('Error updating privacy settings', error.toString());
    }
  }

  public async fetchBusinessProfile(number: string): Promise<NumberBusiness> {
    this.logger.verbose('Fetching business profile');
    try {
      const jid = number ? this.createJid(number) : this.instance.wuid;

      const profile = await this.client.getBusinessProfile(jid);
      this.logger.verbose('Trying to get business profile');

      if (!profile) {
        const info = await this.whatsappNumber({ numbers: [jid] });

        return {
          isBusiness: false,
          message: 'Not is business profile',
          ...info?.shift(),
        };
      }

      this.logger.verbose('Business profile fetched');
      return {
        isBusiness: true,
        ...profile,
      };
    } catch (error) {
      throw new InternalServerErrorException('Error updating profile name', error.toString());
    }
  }

  public async updateProfileName(name: string) {
    this.logger.verbose('Updating profile name to ' + name);
    try {
      await this.client.updateProfileName(name);

      return { update: 'success' };
    } catch (error) {
      throw new InternalServerErrorException('Error updating profile name', error.toString());
    }
  }

  public async updateProfileStatus(status: string) {
    this.logger.verbose('Updating profile status to: ' + status);
    try {
      await this.client.updateProfileStatus(status);

      return { update: 'success' };
    } catch (error) {
      throw new InternalServerErrorException('Error updating profile status', error.toString());
    }
  }

  public async updateProfilePicture(picture: string) {
    this.logger.verbose('Updating profile picture');
    try {
      let pic: WAMediaUpload;
      if (isURL(picture)) {
        this.logger.verbose('Picture is url');

        const timestamp = new Date().getTime();
        const url = `${picture}?timestamp=${timestamp}`;
        this.logger.verbose('Including timestamp in url: ' + url);

        let config: any = {
          responseType: 'arraybuffer',
        };

        if (this.localProxy.enabled) {
          config = {
            ...config,
            httpsAgent: makeProxyAgent(this.localProxy.proxy),
          };
        }

        pic = (await axios.get(url, config)).data;
        this.logger.verbose('Getting picture from url');
      } else if (isBase64(picture)) {
        this.logger.verbose('Picture is base64');
        pic = Buffer.from(picture, 'base64');
        this.logger.verbose('Getting picture from base64');
      } else {
        throw new BadRequestException('"profilePicture" must be a url or a base64');
      }

      await this.client.updateProfilePicture(this.instance.wuid, pic);
      this.logger.verbose('Profile picture updated');

      this.reloadConnection();

      return { update: 'success' };
    } catch (error) {
      throw new InternalServerErrorException('Error updating profile picture', error.toString());
    }
  }

  public async removeProfilePicture() {
    this.logger.verbose('Removing profile picture');
    try {
      await this.client.removeProfilePicture(this.instance.wuid);

      this.reloadConnection();

      return { update: 'success' };
    } catch (error) {
      throw new InternalServerErrorException('Error removing profile picture', error.toString());
    }
  }

  public async blockUser(data: BlockUserDto) {
    this.logger.verbose('Blocking user: ' + data.number);
    try {
      const { number } = data;

      this.logger.verbose(`Check if number "${number}" is WhatsApp`);
      const isWA = (await this.whatsappNumber({ numbers: [number] }))?.shift();

      this.logger.verbose(`Exists: "${isWA.exists}" | jid: ${isWA.jid}`);
      if (!isWA.exists && !isJidGroup(isWA.jid) && !isWA.jid.includes('@broadcast')) {
        throw new BadRequestException(isWA);
      }

      const sender = isWA.jid;

      await this.client.updateBlockStatus(sender, data.status);

      return { block: 'success' };
    } catch (error) {
      throw new InternalServerErrorException('Error blocking user', error.toString());
    }
  }

  public async updateMessage(data: UpdateMessageDto) {
    try {
      const jid = this.createJid(data.number);

      this.logger.verbose('Updating message');
      return await this.client.sendMessage(jid, {
        text: data.text,
        edit: data.key,
      });
    } catch (error) {
      this.logger.error(error);
      throw new BadRequestException(error.toString());
    }
  }

  public async fetchLabels(): Promise<LabelDto[]> {
    this.logger.verbose('Fetching labels');
    const labels = await this.prismaRepository.label.findMany({
      where: {
        instanceId: this.instanceId,
      },
    });

    return labels.map((label) => ({
      color: label.color,
      name: label.name,
      id: label.labelId,
      predefinedId: label.predefinedId,
    }));
  }

  public async handleLabel(data: HandleLabelDto) {
    this.logger.verbose('Adding label');
    const whatsappContact = await this.whatsappNumber({ numbers: [data.number] });
    if (whatsappContact.length === 0) {
      throw new NotFoundException('Number not found');
    }
    const contact = whatsappContact[0];
    if (!contact.exists) {
      throw new NotFoundException('Number is not on WhatsApp');
    }

    try {
      if (data.action === 'add') {
        await this.client.addChatLabel(contact.jid, data.labelId);

        return { numberJid: contact.jid, labelId: data.labelId, add: true };
      }
      if (data.action === 'remove') {
        await this.client.removeChatLabel(contact.jid, data.labelId);

        return { numberJid: contact.jid, labelId: data.labelId, remove: true };
      }
    } catch (error) {
      throw new BadRequestException(`Unable to ${data.action} label to chat`, error.toString());
    }
  }

  // Group
  private async updateGroupMetadataCache(groupJid: string) {
    try {
      const meta = await this.client.groupMetadata(groupJid);
      await groupMetadataCache.set(groupJid, {
        timestamp: Date.now(),
        data: meta,
      });

      return meta;
    } catch (error) {
      this.logger.error(error);
      return null;
    }
  }

  private async getGroupMetadataCache(groupJid: string) {
    if (!isJidGroup(groupJid)) return null;

    if (await groupMetadataCache.has(groupJid)) {
      console.log('Has cache for group: ' + groupJid);
      const meta = await groupMetadataCache.get(groupJid);

      if (Date.now() - meta.timestamp > 3600000) {
        await this.updateGroupMetadataCache(groupJid);
      }

      return meta.data;
    }

    return await this.updateGroupMetadataCache(groupJid);
  }

  public async createGroup(create: CreateGroupDto) {
    this.logger.verbose('Creating group: ' + create.subject);
    try {
      const participants = (await this.whatsappNumber({ numbers: create.participants }))
        .filter((participant) => participant.exists)
        .map((participant) => participant.jid);
      const { id } = await this.client.groupCreate(create.subject, participants);
      this.logger.verbose('Group created: ' + id);

      if (create?.description) {
        this.logger.verbose('Updating group description: ' + create.description);
        await this.client.groupUpdateDescription(id, create.description);
      }

      if (create?.promoteParticipants) {
        this.logger.verbose('Prometing group participants: ' + participants);
        await this.updateGParticipant({
          groupJid: id,
          action: 'promote',
          participants: participants,
        });
      }

      this.logger.verbose('Getting group metadata');
      const group = await this.client.groupMetadata(id);

      return group;
    } catch (error) {
      this.logger.error(error);
      throw new InternalServerErrorException('Error creating group', error.toString());
    }
  }

  public async updateGroupPicture(picture: GroupPictureDto) {
    this.logger.verbose('Updating group picture');
    try {
      let pic: WAMediaUpload;
      if (isURL(picture.image)) {
        this.logger.verbose('Picture is url');

        const timestamp = new Date().getTime();
        const url = `${picture.image}?timestamp=${timestamp}`;
        this.logger.verbose('Including timestamp in url: ' + url);

        let config: any = {
          responseType: 'arraybuffer',
        };

        if (this.localProxy.enabled) {
          config = {
            ...config,
            httpsAgent: makeProxyAgent(this.localProxy.proxy),
          };
        }

        pic = (await axios.get(url, config)).data;
        this.logger.verbose('Getting picture from url');
      } else if (isBase64(picture.image)) {
        this.logger.verbose('Picture is base64');
        pic = Buffer.from(picture.image, 'base64');
        this.logger.verbose('Getting picture from base64');
      } else {
        throw new BadRequestException('"profilePicture" must be a url or a base64');
      }
      await this.client.updateProfilePicture(picture.groupJid, pic);
      this.logger.verbose('Group picture updated');

      return { update: 'success' };
    } catch (error) {
      throw new InternalServerErrorException('Error update group picture', error.toString());
    }
  }

  public async updateGroupSubject(data: GroupSubjectDto) {
    this.logger.verbose('Updating group subject to: ' + data.subject);
    try {
      await this.client.groupUpdateSubject(data.groupJid, data.subject);

      return { update: 'success' };
    } catch (error) {
      throw new InternalServerErrorException('Error updating group subject', error.toString());
    }
  }

  public async updateGroupDescription(data: GroupDescriptionDto) {
    this.logger.verbose('Updating group description to: ' + data.description);
    try {
      await this.client.groupUpdateDescription(data.groupJid, data.description);

      return { update: 'success' };
    } catch (error) {
      throw new InternalServerErrorException('Error updating group description', error.toString());
    }
  }

  public async findGroup(id: GroupJid, reply: 'inner' | 'out' = 'out') {
    this.logger.verbose('Fetching group');
    try {
      const group = await this.client.groupMetadata(id.groupJid);

      const picture = await this.profilePicture(group.id);

      return {
        id: group.id,
        subject: group.subject,
        subjectOwner: group.subjectOwner,
        subjectTime: group.subjectTime,
        pictureUrl: picture.profilePictureUrl,
        size: group.participants.length,
        creation: group.creation,
        owner: group.owner,
        desc: group.desc,
        descId: group.descId,
        restrict: group.restrict,
        announce: group.announce,
        participants: group.participants,
      };
    } catch (error) {
      if (reply === 'inner') {
        return;
      }
      throw new NotFoundException('Error fetching group', error.toString());
    }
  }

  public async fetchAllGroups(getParticipants: GetParticipant) {
    this.logger.verbose('Fetching all groups');
    try {
      const fetch = Object.values(await this.client.groupFetchAllParticipating());
      let groups = [];
      for (const group of fetch) {
        const picture = await this.profilePicture(group.id);

        const result = {
          id: group.id,
          subject: group.subject,
          subjectOwner: group.subjectOwner,
          subjectTime: group.subjectTime,
          pictureUrl: picture.profilePictureUrl,
          size: group.participants.length,
          creation: group.creation,
          owner: group.owner,
          desc: group.desc,
          descId: group.descId,
          restrict: group.restrict,
          announce: group.announce,
        };

        if (getParticipants.getParticipants == 'true') {
          result['participants'] = group.participants;
        }

        groups = [...groups, result];
      }

      return groups;
    } catch (error) {
      throw new NotFoundException('Error fetching group', error.toString());
    }
  }

  public async inviteCode(id: GroupJid) {
    this.logger.verbose('Fetching invite code for group: ' + id.groupJid);
    try {
      const code = await this.client.groupInviteCode(id.groupJid);
      return { inviteUrl: `https://chat.whatsapp.com/${code}`, inviteCode: code };
    } catch (error) {
      throw new NotFoundException('No invite code', error.toString());
    }
  }

  public async inviteInfo(id: GroupInvite) {
    this.logger.verbose('Fetching invite info for code: ' + id.inviteCode);
    try {
      return await this.client.groupGetInviteInfo(id.inviteCode);
    } catch (error) {
      throw new NotFoundException('No invite info', id.inviteCode);
    }
  }

  public async sendInvite(id: GroupSendInvite) {
    this.logger.verbose('Sending invite for group: ' + id.groupJid);
    try {
      const inviteCode = await this.inviteCode({ groupJid: id.groupJid });
      this.logger.verbose('Getting invite code: ' + inviteCode.inviteCode);

      const inviteUrl = inviteCode.inviteUrl;
      this.logger.verbose('Invite url: ' + inviteUrl);

      const numbers = id.numbers.map((number) => this.createJid(number));
      const description = id.description ?? '';

      const msg = `${description}\n\n${inviteUrl}`;

      const message = {
        conversation: msg,
      };

      for await (const number of numbers) {
        await this.sendMessageWithTyping(number, message);
      }

      this.logger.verbose('Invite sent for numbers: ' + numbers.join(', '));

      return { send: true, inviteUrl };
    } catch (error) {
      throw new NotFoundException('No send invite');
    }
  }

  public async acceptInviteCode(id: AcceptGroupInvite) {
    this.logger.verbose('Joining the group by invitation code: ' + id.inviteCode);
    try {
      const groupJid = await this.client.groupAcceptInvite(id.inviteCode);
      return { accepted: true, groupJid: groupJid };
    } catch (error) {
      throw new NotFoundException('Accept invite error', error.toString());
    }
  }

  public async revokeInviteCode(id: GroupJid) {
    this.logger.verbose('Revoking invite code for group: ' + id.groupJid);
    try {
      const inviteCode = await this.client.groupRevokeInvite(id.groupJid);
      return { revoked: true, inviteCode };
    } catch (error) {
      throw new NotFoundException('Revoke error', error.toString());
    }
  }

  public async findParticipants(id: GroupJid) {
    this.logger.verbose('Fetching participants for group: ' + id.groupJid);
    try {
      const participants = (await this.client.groupMetadata(id.groupJid)).participants;
      const contacts = await this.prismaRepository.contact.findMany({
        where: {
          instanceId: this.instanceId,
          remoteJid: {
            in: participants.map((p) => p.id),
          },
        },
      });
      const parsedParticipants = participants.map((participant) => {
        const contact = contacts.find((c) => c.remoteJid === participant.id);
        return {
          ...participant,
          name: participant.name ?? contact?.pushName,
          imgUrl: participant.imgUrl ?? contact?.profilePicUrl,
        };
      });
      return { participants: parsedParticipants };
    } catch (error) {
      throw new NotFoundException('No participants', error.toString());
    }
  }

  public async updateGParticipant(update: GroupUpdateParticipantDto) {
    this.logger.verbose('Updating participants');
    try {
      const participants = update.participants.map((p) => this.createJid(p));
      const updateParticipants = await this.client.groupParticipantsUpdate(
        update.groupJid,
        participants,
        update.action,
      );
      return { updateParticipants: updateParticipants };
    } catch (error) {
      throw new BadRequestException('Error updating participants', error.toString());
    }
  }

  public async updateGSetting(update: GroupUpdateSettingDto) {
    this.logger.verbose('Updating setting for group: ' + update.groupJid);
    try {
      const updateSetting = await this.client.groupSettingUpdate(update.groupJid, update.action);
      return { updateSetting: updateSetting };
    } catch (error) {
      throw new BadRequestException('Error updating setting', error.toString());
    }
  }

  public async toggleEphemeral(update: GroupToggleEphemeralDto) {
    this.logger.verbose('Toggling ephemeral for group: ' + update.groupJid);
    try {
      await this.client.groupToggleEphemeral(update.groupJid, update.expiration);
      return { success: true };
    } catch (error) {
      throw new BadRequestException('Error updating setting', error.toString());
    }
  }

  public async leaveGroup(id: GroupJid) {
    this.logger.verbose('Leaving group: ' + id.groupJid);
    try {
      await this.client.groupLeave(id.groupJid);
      return { groupJid: id.groupJid, leave: true };
    } catch (error) {
      throw new BadRequestException('Unable to leave the group', error.toString());
    }
  }
  public async templateMessage() {
    throw new Error('Method not available in the Baileys service');
  }
}