import { prismaRepository } from '@api/server.module';
import { configService, Database } from '@config/env.config';
import { Logger } from '@config/logger.config';
import dayjs from 'dayjs';

const logger = new Logger('OnWhatsappCache');

function getAvailableNumbers(remoteJid: string) {
  const numbersAvailable: string[] = [];

  if (remoteJid.startsWith('+')) {
    remoteJid = remoteJid.slice(1);
  }

  const [number, domain] = remoteJid.split('@');

  if (domain === 'lid' || domain === 'g.us') {
    return [remoteJid];
  }

  // Brazilian numbers
  if (remoteJid.startsWith('55')) {
    const numberWithDigit =
      number.slice(4, 5) === '9' && number.length === 13 ? number : `${number.slice(0, 4)}9${number.slice(4)}`;
    const numberWithoutDigit = number.length === 12 ? number : number.slice(0, 4) + number.slice(5);

    numbersAvailable.push(numberWithDigit);
    numbersAvailable.push(numberWithoutDigit);
  }
  // Mexican/Argentina numbers
  else if (number.startsWith('52') || number.startsWith('54')) {
    let prefix = '';
    if (number.startsWith('52')) {
      prefix = '1';
    }
    if (number.startsWith('54')) {
      prefix = '9';
    }

    const numberWithDigit =
      number.slice(2, 3) === prefix && number.length === 13
        ? number
        : `${number.slice(0, 2)}${prefix}${number.slice(2)}`;
    const numberWithoutDigit = number.length === 12 ? number : number.slice(0, 2) + number.slice(3);

    numbersAvailable.push(numberWithDigit);
    numbersAvailable.push(numberWithoutDigit);
  }
  // Other countries
  else {
    numbersAvailable.push(remoteJid);
  }

  return numbersAvailable.map((number) => `${number}@${domain}`);
}

interface ISaveOnWhatsappCacheParams {
  remoteJid: string;
  remoteJidAlt?: string;
  lid?: 'lid' | undefined;
}

export async function saveOnWhatsappCache(data: ISaveOnWhatsappCacheParams[]) {
  if (!configService.get<Database>('DATABASE').SAVE_DATA.IS_ON_WHATSAPP) return;

  for (const item of data) {
    const remoteJid = item.remoteJid.startsWith('+') ? item.remoteJid.slice(1) : item.remoteJid;
    const allJids = [remoteJid];

    const altJid =
      item.remoteJidAlt && item.remoteJidAlt.includes('@lid')
        ? item.remoteJidAlt.startsWith('+')
          ? item.remoteJidAlt.slice(1)
          : item.remoteJidAlt
        : null;

    if (altJid) {
      allJids.push(altJid);
    }

    const expandedJids = allJids.flatMap((jid) => getAvailableNumbers(jid));
    const uniqueJids = Array.from(new Set(expandedJids));

    // 🎯 NOVA LÓGICA: Busca por variação em vez de LIKE
    const existingVariation = await prismaRepository.whatsappJidVariation.findFirst({
      where: {
        jidVariation: {
          in: uniqueJids,
        },
      },
      include: {
        contact: {
          include: {
            variations: true,
          },
        },
      },
    });

    const existingContact = existingVariation?.contact;

    logger.verbose(`Register exists: ${existingContact ? existingContact.remoteJid : 'not found'}`);

    const lidValue = item.lid === 'lid' || item.remoteJid?.includes('@lid') ? 'lid' : null;

    if (existingContact) {
      // Atualiza contato existente
      await prismaRepository.whatsappContact.update({
        where: { id: existingContact.id },
        data: {
          remoteJid,
          lid: lidValue,
          updatedAt: new Date(),
        },
      });

      // Pega variações existentes
      const existingVariations = new Set(existingContact.variations.map((v) => v.jidVariation));

      // Identifica novas variações
      const newVariations = uniqueJids.filter((jid) => !existingVariations.has(jid));

      // Insere apenas as novas
      if (newVariations.length > 0) {
        await prismaRepository.whatsappJidVariation.createMany({
          data: newVariations.map((jid) => ({
            contactId: existingContact.id,
            jidVariation: jid,
          })),
          skipDuplicates: true,
        });

        logger.verbose(`Added ${newVariations.length} new variations for ${remoteJid}`);
      }
    } else {
      // Cria novo contato com todas as variações
      await prismaRepository.whatsappContact.create({
        data: {
          remoteJid,
          lid: lidValue,
          variations: {
            createMany: {
              data: uniqueJids.map((jid) => ({
                jidVariation: jid,
              })),
              skipDuplicates: true,
            },
          },
        },
      });

      logger.verbose(`Created new contact: ${remoteJid} with ${uniqueJids.length} variations`);
    }

    logger.verbose(`Saving: remoteJid=${remoteJid}, variations=${uniqueJids.length}, lid=${lidValue}`);
  }
}

export async function getOnWhatsappCache(remoteJids: string[]) {
  let results: {
    remoteJid: string;
    number: string;
    jidOptions: string[];
    lid?: string;
  }[] = [];

  if (!configService.get<Database>('DATABASE').SAVE_DATA.IS_ON_WHATSAPP) {
    return results;
  }

  const remoteJidsExpanded = remoteJids.map((remoteJid) => getAvailableNumbers(remoteJid)).flat();
  const uniqueJids = Array.from(new Set(remoteJidsExpanded));

  const dateLimit = dayjs()
    .subtract(configService.get<Database>('DATABASE').SAVE_DATA.IS_ON_WHATSAPP_DAYS, 'days')
    .toDate();

  // 🎯 NOVA LÓGICA: Busca direta por índice
  const contacts = await prismaRepository.whatsappContact.findMany({
    where: {
      variations: {
        some: {
          jidVariation: {
            in: uniqueJids,
          },
        },
      },
      updatedAt: {
        gte: dateLimit,
      },
    },
    include: {
      variations: true,
    },
  });

  results = contacts.map((contact) => ({
    remoteJid: contact.remoteJid,
    number: contact.remoteJid.split('@')[0],
    jidOptions: contact.variations.map((v) => v.jidVariation),
    lid: contact.lid,
  }));

  return results;
}
