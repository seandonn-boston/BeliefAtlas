import { ImageResponse } from "next/og";
import { brandName } from "@/lib/front-door";
import { getQuestion } from "@/lib/questions";

// The preview card every share link unfurls into (iMessage, WhatsApp, Slack, Discord, X,
// Bluesky, Facebook, LinkedIn, ...): the question and its answers, drawn as buttons, in
// our own look. Results are never in it, so the first answer stays the person's own.

export const alt = "A true-or-false question";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const INK = "#eef1f6";
const DIM = "#99a1ae";

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const questionId = Number((await params).id);
  const question = Number.isInteger(questionId) && questionId > 0 ? await getQuestion(questionId) : null;
  const text = question?.text ?? "True or false?";
  const fontSize = text.length > 140 ? 52 : text.length > 90 ? 62 : text.length > 50 ? 76 : 88;

  const pill = (label: string, color: string, wide = false) => (
    <div
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        height: 96, width: 320, borderRadius: 14,
        border: "2px solid #23262c", borderBottom: `8px solid ${color}`,
        color: wide ? DIM : INK, fontSize: wide ? 36 : 46, fontWeight: 700,
      }}
    >
      {label}
    </div>
  );

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between",
          background: "#000000", color: INK, padding: "56px 72px",
        }}
      >
        <div style={{ display: "flex", fontSize: 34, fontWeight: 700, color: DIM }}>{brandName()}</div>
        <div style={{ display: "flex", fontSize, fontWeight: 700, lineHeight: 1.1, letterSpacing: -1 }}>{text}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          {pill("True", "#2196e8")}
          {pill("False", "#dd6f17")}
          {pill("Don't know", "#6b7480", true)}
        </div>
      </div>
    ),
    size,
  );
}
