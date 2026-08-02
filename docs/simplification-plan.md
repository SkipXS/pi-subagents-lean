# Vereinfachungsplan: Tool-first ohne TUI und Nested Delegation

## Status

Phase 3 ist auf diesem Branch umgesetzt. Dieses Dokument bleibt als Zielbild,
Begründung und Akzeptanz-Checkliste erhalten.

## Entscheidung

Die Extension wird auf ein flaches, toolbasiertes Delegationsmodell reduziert:

- Die interaktive TUI wird entfernt.
- Nested Delegation wird entfernt.
- `AgentContinue` bleibt erhalten.
- Root-Agents können weiterhin im Vordergrund oder Hintergrund ausgeführt werden.
- `StopAgent` und `AgentStatus` bleiben als nicht-visuelle Kontrollmöglichkeiten erhalten.

Das angestrebte Modell ist:

```text
Parent-Session
 ├─ Agent A
 │   └─ optional über AgentContinue fortsetzbar
 └─ Agent B
     └─ optional über AgentContinue fortsetzbar
```

Ein Subagent erhält kein `Agent`-Tool und kann keine weiteren Subagents starten.

## Motivation

Der Kernnutzen der Extension besteht darin, spezialisierte Agents in isolierten Sessions auszuführen und ihre Ergebnisse an die Parent-Session zurückzugeben. Die TUI und Nested Delegation erhöhen den Implementierungs-, Test- und Wartungsaufwand deutlich, sind dafür aber nicht zwingend erforderlich.

Die TUI unter `src/ui/` umfasst ungefähr 7.500 Zeilen Produktivcode und enthält unter anderem einen Live-Conversation-Viewer mit Streaming, Polling, Branch- und Compaction-Verarbeitung, Scroll-Zustand und mehreren Timern. Nested Delegation verteilt zusätzliche Zustände und Regeln über Manager, Runner, Coordinator, Prompts, Konfiguration und UI.

Durch die Entfernung beider Bereiche wird aus der Extension ein kleineres und leichter verständliches Tool-System mit einer eindeutigen Verantwortungsgrenze zwischen Parent und Subagent.

## Ziele

- Den Hauptpfad Parent → Subagent erhalten.
- Foreground- und Background-Ausführung erhalten.
- Fertige Agents mit ihrem vorhandenen Session-Kontext fortsetzen können.
- Lifecycle, Queue, Concurrency, Abbruch und Ergebniszustellung vereinfachen.
- TUI-spezifische Laufzeitpfade, Timer und Zustände vollständig entfernen.
- Hierarchie-, Tiefen- und Child-Budget-Logik vollständig entfernen.
- Headless-, RPC-, JSON- und Print-Nutzung als primären Betriebsmodus behandeln.
- Bestehende Konfigurationsdateien möglichst tolerant weiter einlesen.

## Nicht-Ziele

- `AgentContinue` in diesem Umbau neu zu entwerfen oder zu entfernen.
- Scheduling oder Join-Modi einzuführen.
- Worktree-Unterstützung zu entfernen.
- Agent-Markdown, Skills, Extensions oder Modellauswahl grundsätzlich zu ändern.
- Das Parent-Orchestration-Prompt vollständig abzuschaffen.
- Eine neue Web- oder Terminaloberfläche als Ersatz für die TUI zu bauen.

## Verbleibende öffentliche Werkzeuge

### `Agent`

Startet einen Root-Agent im Vordergrund oder Hintergrund. Jeder Aufruf gehört direkt zur Parent-Session.

### `AgentContinue`

Setzt einen bereits beendeten, direkt von der Parent-Session gestarteten Agent mit einem neuen Prompt fort. Die vorhandene Session und ihr Kontext werden wiederverwendet.

Für `AgentContinue` gelten folgende Invarianten:

1. Nur Root-Agents sind fortsetzbar.
2. Ein laufender oder wartender Agent ist nicht fortsetzbar.
3. Pro Agent darf nur eine Ausführung oder Fortsetzung gleichzeitig aktiv sein.
4. Gestoppte, abgebrochene oder fehlgeschlagene Agents bleiben gemäß bestehendem Vertrag nicht fortsetzbar.
5. `run_in_background` bleibt unterstützt; das Ergebnis wird über den normalen Background-Zustellungsweg geliefert.
6. Retention bleibt begrenzt, damit beendete Sessions nicht unbegrenzt Speicher belegen.

### `StopAgent`

Stoppt einen laufenden oder wartenden Root-Agent. Kaskadierende Child-Abbrüche sind nach Entfernung von Nested Delegation nicht mehr erforderlich.

### `AgentStatus`

Liefert den Zustand direkt gestarteter Agents ohne Abhängigkeit von Widget oder Conversation Viewer.

## Zu entfernender Umfang

### 1. TUI

Der gesamte interaktive UI-Bereich soll entfallen:

- `src/ui/agent-widget.ts`
- `src/ui/conversation-viewer.ts`
- `src/ui/agent-hierarchy.ts`
- `src/ui/viewer-keys.ts`
- `src/ui/renderer.ts`
- `src/ui/searchable-select.ts`
- `src/ui/markdown-theme.ts`
- `src/ui/eco-status.ts`
- `src/ui/menu/**`
- weitere ausschließlich visuelle Hilfsfunktionen unter `src/ui/`

Außerdem entfallen:

- Registrierung des `/agents`-Kommandos;
- Widget-Erstellung und Widget-Navigation;
- Terminal-Input-Listener für UI-Navigation;
- Conversation-Viewer und manuelles Steering über die TUI;
- manuelles Spawnen über Menüs;
- TUI-basierte Einstellungen und Recovery-Dialoge;
- UI-spezifische Renderer, sofern Pi ohne sie einen ausreichenden Standard-Fallback besitzt;
- Live-View-, Streaming- und Anzeige-Callbacks, die keine fachliche Wirkung haben.

Nicht-visuelle Hilfsfunktionen, die derzeit unter `src/ui/` liegen, werden entweder in ein passendes neutrales Modul verschoben oder lokal vereinfacht. Dazu kann beispielsweise die Zusammenfassung von Tool-Argumenten gehören.

### 2. Nested Delegation

Folgende Konzepte entfallen:

- `src/agents/nested-agent-proxy.ts`;
- Child-spezifische Runtime-Kontexte und Executor-Factories;
- `delegate_to` und `max_child_agents` als wirksame Agent-Konfiguration;
- maximale Nesting-Tiefe;
- Parent-/Child-Hierarchien in Agent-Records;
- Child-Budgets und Active-Child-Zustände;
- Nested-Preflight und Rollenfreigaben;
- Vererbung von Worktree- und Katalog-Snapshots an Child-Agents;
- Child-spezifische Orchestration-Prompts;
- Sonderregeln für globale Slots während verschachtelter Ausführung;
- kaskadierende Child-Abbrüche und Child-Retention.

Subagent-Sessions dürfen die Extension weiterhin isoliert laden, aber sie erhalten kein funktionsfähiges `Agent`-Tool. Notwendige Session-Isolation darf daher nicht zusammen mit der Delegationsfähigkeit entfernt werden.

## Beizubehaltender Kern

- Tool-Registrierung für `Agent`, `AgentContinue`, `StopAgent` und `AgentStatus`;
- Agent-Discovery und Agent-Markdown;
- isolierte Pi-Sessions;
- Foreground- und Background-Ausführung;
- globale Root-Concurrency und Queue;
- atomare Annahme eines Root-Auftrags;
- Modell-, Thinking-, Tool-, Skill- und Extension-Auflösung;
- Worktree-Validierung;
- Turn- und Token-Limits;
- Usage-Erfassung;
- Output-Logs;
- Background-Zustellung über `sendMessage()`;
- sauberer Shutdown und Abbruch laufender Root-Agents;
- Session-Retention für `AgentContinue`.

## Konfiguration und Kompatibilität

Die Entfernung soll bestehende Konfigurationsdateien nicht unnötig unlesbar machen.

- Alte UI-Schlüssel werden zunächst tolerant ignoriert, statt das Laden abzulehnen.
- `delegate_to`, `max_child_agents` und Nesting-Einstellungen werden zunächst als veraltete Felder akzeptiert und ignoriert.
- Neue Schreibvorgänge sollen entfernte Felder nicht mehr erzeugen.
- Eine spätere Hauptversion kann die veralteten Felder und Parser endgültig entfernen.
- Eco-Einstellungen benötigen eine gesonderte Entscheidung: Bleibt Eco fachlich erhalten, muss es ohne TUI über Konfiguration nutzbar sein; andernfalls wird es ausdrücklich als Teil der TUI-Entfernung gestrichen.
- README, `CONTEXT.md`, Agent-Beispiele und Konfigurationsreferenz müssen den flachen Ausführungsbaum beschreiben.

## Umsetzung in Phasen

### Phase 1: Headless-Vertrag absichern

Vor strukturellen Änderungen werden bestehende Integrationstests auf den gewünschten Kernvertrag ausgerichtet:

- Foreground-Start liefert das finale Ergebnis.
- Background-Start bestätigt sofort und liefert später genau eine Abschlussnachricht.
- `AgentContinue` funktioniert im Vordergrund und Hintergrund.
- `StopAgent` stoppt laufende oder wartende Root-Agents.
- `AgentStatus` zeigt Root-Zustände korrekt.
- Shutdown beendet oder bereinigt alle Root-Ausführungen.
- Alle Kernpfade funktionieren mit `hasUI: false`.

### Phase 2: TUI entfernen

1. `/agents`, Widget, Viewer und Navigation aus Registrierung, Events und Shell lösen.
2. Fachliche Logik von rein visuellen Callbacks trennen.
3. `src/ui/` und die zugehörigen Tests entfernen.
4. Nicht-visuelle Hilfsfunktionen verschieben oder vereinfachen.
5. TUI-Abhängigkeiten erst entfernen, wenn keine verbleibenden Runtime-Imports existieren.
6. Dokumentation auf toolbasierte Bedienung umstellen.

Nach dieser Phase muss das Verhalten der vier Tools unverändert sein; die
Ausführung bleibt auf direkte Root-Agents beschränkt.

### Phase 3: Nested Delegation entfernen (umgesetzt)

1. Das `Agent`-Proxy-Tool aus Subagent-Sessions entfernen.
2. Child-Promptblöcke und Child-Kataloge entfernen.
3. Nested Executor und Nested Runtime Context entfernen.
4. Manager auf flache Root-Records reduzieren.
5. Coordinator auf Root-Spawns und Root-Continuations reduzieren.
6. Hierarchie-, Tiefen-, Child-Budget- und Kaskadenlogik entfernen.
7. Agent-Definitionen und Konfiguration von Delegationsfeldern bereinigen.
8. Nested-spezifische Tests entfernen und Root-Lifecycle-Tests beibehalten oder verstärken.

### Phase 4: `AgentContinue` isolieren und vereinfachen

`AgentContinue` bleibt funktional erhalten, wird aber vom entfernten Hierarchiemodell getrennt:

- Fortsetzung arbeitet nur mit Root-Agent-IDs.
- Berechtigungsprüfungen beziehen sich nicht mehr auf Parent-/Child-Beziehungen.
- Retention speichert nur Daten, die für Status, Ergebnis und Fortsetzung benötigt werden.
- Foreground- und Background-Fortsetzungen verwenden denselben Ausführungspfad wie möglich.
- Ausgabe- und Usage-Historie bleiben pro Ausführung nachvollziehbar.

Diese Phase ist eine interne Vereinfachung und keine Entfernung des Features.

### Phase 5: Dokumentation und Bereinigung

- README und `CONTEXT.md` aktualisieren.
- Entfernte Optionen und UI-Beschreibungen löschen oder als Migration dokumentieren.
- Paketinhalt und Abhängigkeiten prüfen.
- Verwaiste Tests, Fixtures und Exporte entfernen.
- Coverage-Schwellen an den kleineren Codebestand anpassen, ohne die Qualität des Kernpfads zu senken.

## Akzeptanzkriterien

Der Umbau ist abgeschlossen, wenn:

1. Die Extension ohne Custom-TUI geladen und verwendet werden kann.
2. Kein Runtime-Pfad `ctx.ui.custom()`, `setWidget`, Widget-Navigation oder Viewer-Timer verwendet.
3. Kein Subagent ein `Agent`-Tool erhält oder einen weiteren Subagent starten kann.
4. Agent-Records keine fachlich wirksamen Parent-/Child-Zustände mehr benötigen.
5. `Agent`, `AgentContinue`, `StopAgent` und `AgentStatus` weiterhin registriert sind.
6. Foreground- und Background-Ausführung inklusive genau-einmaliger Ergebniszustellung funktionieren.
7. Ein regulär beendeter Root-Agent erfolgreich fortgesetzt werden kann.
8. Queue, Concurrency, Abbruch und Shutdown für Root-Agents getestet sind.
9. Worktrees und Session-Isolation weiterhin funktionieren.
10. Alte Konfigurationsdateien mit entfernten UI- oder Delegationsfeldern nicht zu einem Startfehler führen.
11. `bun run typecheck` und `bun run test` erfolgreich durchlaufen.
12. README, `CONTEXT.md` und Konfigurationsdokumentation dem tatsächlichen Verhalten entsprechen.

## Risiken

### Verlust manueller Bedienbarkeit

Ohne `/agents` können Nutzer Agents nicht mehr ohne LLM-Aufruf starten oder konfigurieren. Die Extension richtet sich damit klarer an modellgesteuerte Delegation und Headless-Nutzung.

### Weniger Live-Beobachtung

Widget und Conversation Viewer entfallen. Status und Stop bleiben über Tools verfügbar; Output-Logs bleiben die technische Diagnosemöglichkeit.

### Versehentliche Kopplung von Isolation und Delegation

Nested Delegation nutzt Teile der Session-Isolation. Beim Entfernen darf nicht angenommen werden, dass jeder AsyncLocalStorage- oder Extension-Filter ausschließlich für Nested Delegation existiert. Die Isolation geladener Child-Extensions muss mit einer realistischen Session-Sequenz geprüft werden.

### Retention durch `AgentContinue`

Beendete Sessions müssen weiterhin zeitweise im Speicher bleiben. Ohne klare Grenzen könnte `AgentContinue` langfristig Ressourcen halten. Bestehende Retention-Regeln müssen daher erhalten oder vereinfacht, aber nicht ersatzlos entfernt werden.

### Konfigurationsmigration

Ein sofortiges hartes Ablehnen alter Felder würde vorhandene Installationen unnötig beschädigen. Die erste Version sollte entfernte Felder tolerant ignorieren und die Änderung deutlich dokumentieren.

## Bewusst vertagte Entscheidungen

Nach Abschluss des Umbaus kann separat bewertet werden:

- ob Eco Mode ohne TUI genügend Nutzen bietet;
- ob persistente Konfiguration weiter vereinfacht werden kann;
- wie lange fortsetzbare Sessions retained werden;
- ob `AgentContinue` langfristig den verbleibenden Wartungsaufwand rechtfertigt;
- ob `AgentStatus` zusätzlich kompakte Usage- oder Log-Informationen liefern soll.

Diese Entscheidungen sind nicht Voraussetzung für das flache Zielmodell.
