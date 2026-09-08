import StudyBisonApp from "@/components/studybison/studybison-app";
import AccessGate from "@/components/access-gate";

export default function Home() {
  return (
    <AccessGate>
      <StudyBisonApp />
    </AccessGate>
  );
}
