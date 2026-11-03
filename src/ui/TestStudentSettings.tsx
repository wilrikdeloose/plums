import type { AppData } from "../core/schema";
import type { CanvasCourse } from "../core/mcp/types";
import { useServices } from "./context";

/** Everything in this module is rendered only when `TEST_BUILD` is true, so normal builds drop it entirely. */
export function TestBuildBanner() {
  const { platform } = useServices();
  const warning = platform.capabilities.testBuildWarning;
  return (
    <div className={warning ? "test-build-banner warning" : "test-build-banner"} role="status">
      <strong>TESTBUILD</strong> · Canvas Test Student{" "}
      {warning ? `uitgeschakeld: ${warning}` : "beschikbaar per cursus (Instellingen → Canvas). Niet voor normaal gebruik."}
    </div>
  );
}

export function TestStudentSettings({
  data,
  courses,
  update,
}: {
  data: AppData;
  courses: readonly CanvasCourse[];
  update: (mutate: (d: AppData) => void) => void;
}) {
  const { platform } = useServices();
  const canvas = data.settings.canvas;
  const builtin = platform.capabilities.builtInMcp && data.settings.mcp.mode === "builtin";
  const names = new Map(courses.map((c) => [c.id, c.name]));

  const toggle = (courseId: string, checked: boolean) =>
    update((d) => {
      const current = new Set(d.settings.canvas.testStudentCourseIds);
      if (checked) current.add(courseId);
      else current.delete(courseId);
      d.settings.canvas.testStudentCourseIds = [...current];
    });

  return (
    <section className="test-student">
      <h3>
        Canvas Test Student <span className="test-badge">Testbuild</span>
      </h3>
      <p className="muted small">
        Standaard uit, per cursus. Aangevinkt leest PLuMS in die cursus de inleverstatus van de Canvas Test Student
        (Studentweergave) in plaats van je eigen account. De ingebouwde server zoekt die Test Student zelf op in Canvas;
        PLuMS maakt hem nooit aan en accepteert geen andere student-ID&apos;s. Resultaten worden als testgegevens gelabeld
        en buiten een testbuild nooit als context gebruikt.
      </p>
      {!platform.capabilities.canvasTestStudent ? (
        <p className="unavailable">
          Niet beschikbaar: {platform.capabilities.testBuildWarning ?? "de native code ondersteunt de testmodus niet."}
        </p>
      ) : !builtin ? (
        <p className="unavailable">
          Niet beschikbaar met een externe MCP-server: alleen de ingebouwde Canvas-server heeft deze gecontroleerde functie.
        </p>
      ) : canvas.selectedCourseIds.length === 0 ? (
        <p className="muted small">Selecteer eerst een cursus hierboven.</p>
      ) : (
        <div className="checks">
          {!canvas.categories.submissions && (
            <span className="field-hint">Schakel de categorie &lsquo;Eigen inleverstatus&rsquo; in om dit te gebruiken.</span>
          )}
          {canvas.selectedCourseIds.map((id) => (
            <label key={id} className="check">
              <input
                type="checkbox"
                checked={canvas.testStudentCourseIds.includes(id)}
                disabled={!canvas.categories.submissions}
                onChange={(e) => toggle(id, e.target.checked)}
              />
              <span>
                {names.get(id) ?? `Cursus-ID ${id}`} · <span className="muted small">als Canvas Test Student lezen</span>
              </span>
            </label>
          ))}
        </div>
      )}
    </section>
  );
}
