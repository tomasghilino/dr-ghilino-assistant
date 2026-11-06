/**
 * Texts the widget shows, served by GET /v1/config so they can change without rebuilding the
 * widget. The disclosure is the wording agreed in PRIVACY.md ("Visitor-facing text").
 */
export const WIDGET_CONFIG = {
  title: "Asistente virtual",
  subtitle: "Dr. Luis Ghilino · Traumatología",
  greeting:
    "Hola, soy el asistente virtual del consultorio del Dr. Ghilino. Te ayudo con consultorios, horarios, turnos y contacto.",
  disclosure:
    "Soy un asistente virtual con inteligencia artificial. Respondo con la información publicada en este sitio y no reemplazo una consulta médica. No compartas datos personales ni de salud. Puedo equivocarme: confirmá los datos importantes por WhatsApp.",
  privacyNote:
    "Tus mensajes se procesan con servicios de inteligencia artificial de terceros. El historial de esta conversación se borra a los {minutes} minutos sin actividad o cuando tocás «Borrar conversación».",
  suggestions: [
    "¿Dónde atiende?",
    "¿Qué días y horarios atiende?",
    "¿Cómo pido un turno?",
    "¿Cuánto cuesta la consulta?",
  ],
} as const;
