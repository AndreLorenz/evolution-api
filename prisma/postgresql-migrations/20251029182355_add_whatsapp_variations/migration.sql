-- Criar novas tabelas
CREATE TABLE "WhatsappContact" (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  remote_jid VARCHAR(100) UNIQUE NOT NULL,
  lid VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE TABLE "WhatsappJidVariation" (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  contact_id VARCHAR(36) NOT NULL REFERENCES "WhatsappContact"(id) ON DELETE CASCADE,
  jid_variation VARCHAR(150) UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_contact_id ON "WhatsappJidVariation"(contact_id);
CREATE INDEX idx_jid_variation ON "WhatsappJidVariation"(jid_variation);

-- Migrar dados da tabela antiga (OPCIONAL - rode depois de testar)
-- INSERT INTO "WhatsappContact" (remote_jid, lid, created_at, updated_at)
-- SELECT "remoteJid", lid, "createdAt", "updatedAt" 
-- FROM public."IsOnWhatsapp";

-- INSERT INTO "WhatsappJidVariation" (contact_id, jid_variation)
-- SELECT 
--   wc.id,
--   UNNEST(string_to_array(iow."jidOptions", ','))
-- FROM public."IsOnWhatsapp" iow
-- JOIN "WhatsappContact" wc ON wc.remote_jid = iow."remoteJid";