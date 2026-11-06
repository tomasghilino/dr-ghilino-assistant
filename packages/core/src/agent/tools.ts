import { z } from "zod";
import type { ClinicProfile } from "../domain/clinic-profile.ts";
import type { JsonObjectSchema, LlmToolDefinition } from "../llm/types.ts";
import { assembleContext, sourceBlock } from "../retrieval/context.ts";
import type { RetrievalService } from "../retrieval/service.ts";
import { type ClinicRepository, describeHours, localPhone } from "./clinic.ts";
import type { SourceRegistry } from "./sources.ts";

/**
 * The agent's four tools (ADR 0006). All are read-only: the worst a prompt injection can do is
 * change the wording of an answer, never act on anything. Every tool:
 * - validates its input with zod (strict tool schemas already constrain it; this is the second
 *   check, because the input crosses a trust boundary);
 * - returns text with `<source>` blocks whose ids come from the turn's SourceRegistry;
 * - reports failures as results with `isError`, so the model can try something else.
 */

export interface ToolContext {
  registry: SourceRegistry;
}

export interface ToolMetrics {
  retrievalMs: number;
  embeddingTokens: number;
  bestSimilarity: number | null;
  chunks: number;
  confident: boolean;
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
  metrics?: ToolMetrics;
}

export interface AgentTool {
  definition: LlmToolDefinition;
  run(input: unknown, context: ToolContext): Promise<ToolOutcome>;
}

const NO_INPUT: JsonObjectSchema = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
};
const noInput = z.object({}).strict();

export function createAgentTools(deps: {
  retrieval: RetrievalService;
  clinic: ClinicRepository;
  maxContextTokens: number;
}): AgentTool[] {
  const withProfile =
    (render: (profile: ClinicProfile, registry: SourceRegistry) => string) =>
    async (input: unknown, context: ToolContext): Promise<ToolOutcome> => {
      if (!noInput.safeParse(input ?? {}).success) return invalidInput();
      const profile = await deps.clinic.activeProfile();
      if (!profile) {
        return {
          content:
            "The clinic profile is not available right now. Try search_knowledge instead, or tell the visitor you could not check.",
          isError: true,
        };
      }
      return { content: render(profile, context.registry), isError: false };
    };

  return [
    {
      definition: {
        name: "search_knowledge",
        description:
          "Search the text of Dr. Ghilino's website (sections, FAQ answers, conditions and treatments). Use it for any question about the practice that the other tools do not cover, and to double-check details. Returns passages inside <source> tags with ids to cite, or says that nothing reliable was found.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "A short search query in Spanish with the key words of the visitor's question, e.g. 'infiltraciones de rodilla' or 'turno San Miguel'.",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      async run(input, context) {
        const parsed = z.object({ query: z.string().trim().min(1).max(300) }).safeParse(input);
        if (!parsed.success) return invalidInput();
        const result = await deps.retrieval.search({ query: parsed.data.query });
        const metrics: ToolMetrics = {
          retrievalMs: result.timings.totalMs,
          embeddingTokens: result.usage.embeddingTokens,
          bestSimilarity: result.bestSimilarity,
          chunks: 0,
          confident: result.confident,
        };
        if (!result.confident || result.chunks.length === 0) {
          return {
            content:
              'No reliable match on the website for this query. Do not answer from general knowledge. If a different query with other key words could match, you may search once more; otherwise tell the visitor the website does not include this and offer WhatsApp (kind "abstained").',
            isError: false,
            metrics,
          };
        }
        const context_ = assembleContext(result.chunks, deps.maxContextTokens, (title, url) =>
          context.registry.register(title, url),
        );
        metrics.chunks = context_.sources.length;
        return {
          content: `Passages from the website, best match first. Quote facts only from these and cite their ids.\n\n${context_.text}`,
          isError: false,
          metrics,
        };
      },
    },
    {
      definition: {
        name: "get_appointment_information",
        description:
          "The offices: address, days and opening hours, whether an appointment is needed and how to get one. Call it for any question about where, when, hours, today, appointments or walk-ins.",
        inputSchema: NO_INPUT,
      },
      run: withProfile((profile, registry) =>
        profile.offices
          .map((office) => {
            const id = registry.register(`Consultorio ${office.name}`, office.sourceUrl);
            const address = [office.streetAddress, office.locality, office.region]
              .filter(Boolean)
              .join(", ");
            const body = [
              `Consultorio ${office.name}`,
              `Dirección: ${address}`,
              `Días y horarios: ${describeHours(office.hours).join("; ")}`,
              `Lo que dice el sitio: ${office.notes}`,
            ].join("\n");
            return sourceBlock(id, `Consultorio ${office.name}`, office.sourceUrl, body);
          })
          .join("\n\n"),
      ),
    },
    {
      definition: {
        name: "get_contact_information",
        description:
          "The practice's WhatsApp number, phone number and e-mail address. Call it when the visitor asks how to contact the doctor, book, or send a question.",
        inputSchema: NO_INPUT,
      },
      run: withProfile((profile, registry) => {
        const { contact } = profile;
        const lines = [
          contact.whatsappUrl && contact.phone
            ? `WhatsApp: ${localPhone(contact.phone)} (${contact.phone})`
            : null,
          contact.phone ? `Teléfono: ${localPhone(contact.phone)}` : null,
          contact.email ? `Correo: ${contact.email}` : null,
          "El sitio indica que la forma más rápida es WhatsApp.",
        ].filter((line): line is string => line !== null);
        const id = registry.register("Contacto", profile.sourceUrl);
        return sourceBlock(id, "Contacto", profile.sourceUrl, lines.join("\n"));
      }),
    },
    {
      definition: {
        name: "get_clinic_information",
        description:
          "About the doctor and the practice: name, specialty, license number (matrícula), training, memberships, conditions treated, services, and the consultation fee. Call it for questions about who the doctor is, his credentials, what he treats, or how much the consultation costs.",
        inputSchema: NO_INPUT,
      },
      run: withProfile((profile, registry) => {
        const { doctor } = profile;
        const about = [
          `Nombre: ${doctor.name}`,
          doctor.jobTitle ? `Profesión: ${doctor.jobTitle} (Ortopedia y Traumatología)` : null,
          doctor.license ? `Matrícula: ${doctor.license}` : null,
          doctor.education.length > 0 ? `Formación: ${doctor.education.join("; ")}` : null,
          doctor.memberships.length > 0 ? `Colegiación: ${doctor.memberships.join("; ")}` : null,
          `Descripción: ${doctor.description}`,
          doctor.topics.length > 0 ? `Patologías que trata: ${doctor.topics.join(", ")}` : null,
          doctor.services.length > 0 ? `Prestaciones: ${doctor.services.join(", ")}` : null,
        ].filter((line): line is string => line !== null);
        const blocks = [
          sourceBlock(
            registry.register("Sobre el Dr. Ghilino", profile.sourceUrl),
            "Sobre el Dr. Ghilino",
            profile.sourceUrl,
            about.join("\n"),
          ),
        ];
        const feeBody = profile.fee
          ? `Valor de la consulta: ${profile.fee.amount}. El sitio no publica precios de prácticas ni de tratamientos, ni información sobre obras sociales o prepagas.`
          : "El sitio no publica el valor de la consulta.";
        blocks.push(
          sourceBlock(
            registry.register("Valor de la consulta", profile.sourceUrl),
            "Valor de la consulta",
            profile.sourceUrl,
            feeBody,
          ),
        );
        return blocks.join("\n\n");
      }),
    },
  ];
}

function invalidInput(): ToolOutcome {
  return { content: "Invalid input for this tool. Check the parameters and retry.", isError: true };
}
