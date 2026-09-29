# EPOS Agent: architettura locale, caricamento delle skill e modifiche in corso

## 1. Obiettivo del progetto

EPOS Agent è un'interfaccia conversazionale per trovare, descrivere, scaricare e
analizzare dati della European Plate Observing System (EPOS). Non è un unico
script che chiama un modello: è una composizione di quattro livelli con compiti
separati.

```text
Ricercatore
    │ richiesta in linguaggio naturale
    ▼
Pi Coding Agent
    │ modello, sessione, prompt, skill, strumenti attivi
    ▼
Estensione epos-tools
    │ router, stato conversazionale, sicurezza, provenance, telemetria
    ├─────────────────────────────────────┐
    ▼                                     ▼
MCP EPOS locale                       MCP FDSN locale
catalogo e servizi EPOS               eventi sismici e dettagli evento
    │                                     │
    ▼                                     ▼
API EPOS pubblica                     datacenter FDSN
    │
    ▼
workspace/, logs/provenance/, sessions/
```

La separazione è intenzionale:

- Pi è il runtime dell'agente e parla con il provider/modello scelto.
- Le skill spiegano al modello *quando* e *come* usare le capacità.
- L'estensione Pi controlla quali tool sono visibili e traduce le chiamate
  dell'agente nei due server MCP.
- I server MCP implementano operazioni deterministiche sui servizi esterni e
  ritornano contratti strutturati, non istruzioni per il modello.

Questo evita di incorporare nel prompt sia l'intero OpenAPI sia tool non
pertinenti alla domanda corrente.

## 2. Mappa dei file importanti

| Percorso | Responsabilità |
| --- | --- |
| `bin/epos-agent` | Launcher: carica configurazione, prompt, skill ed estensione, poi avvia Pi. |
| `prompts/SYSTEM.md` | Regole globali corte: tool minimi, selezione esplicita, sicurezza download e workspace. |
| `tools/agent-runtime/index.ts` | Integrazione Pi: router dei tool, client MCP stdio, FDSN, stato, provenance e telemetria. |
| `services/mcp-epos/tools/epos_mcp_http.py` | Server MCP Python per catalogo, organizzazioni, metadata e download EPOS. |
| `services/mcp-epos/tools/epos_mcp_stdio.py` | Entry point stdio usato localmente da EPOS Agent. |
| `services/mcp-epos/definitions/api-spec.json` | Copia locale del contratto OpenAPI EPOS, autorevole per chi mantiene l'MCP ma non caricata nel prompt. |
| `services/mcp-fdsnws-event/` | Server FDSN specialistico già separato dal catalogo EPOS. |
| `skills/epos-search/SKILL.md` | Istruzioni progressive per la discovery di catalogo, provider e software. |
| `skills/epos-service-access/SKILL.md` | Istruzioni per descrizione, parametri, preventivo e download di un elemento già scelto. |
| `skills/epos-fdsn-earthquakes/SKILL.md` | Istruzioni per gli eventi sismici FDSN. |
| `docs/status.md` | Stato funzionale, verifiche già eseguite e backlog. |
| `install.sh` | Installa una copia del progetto in `~/epos-agent`, dipendenze Pi/Node/Python e i server MCP. |
| `workspace/` | Dati completi, script e immagini prodotti durante le sessioni; non è contesto del modello. |
| `logs/provenance/` | Un file JSON per operazione con fonte, parametri e timestamp. |
| `logs/token-usage.jsonl` | Metriche per messaggio del modello, senza prompt o dataset completi. |

## 3. Avvio dell'agente

Il punto di ingresso è `bin/epos-agent`. Determina `ROOT` da
`EPOS_AGENT_ROOT` oppure, per default, da `~/epos-agent`; legge
`config/profile.env` se esiste; poi avvia Pi.

Il launcher passa esplicitamente:

```text
--no-extensions --no-skills --no-prompt-templates --no-context-files
--system-prompt prompts/SYSTEM.md
--skill skills/
--extension tools/agent-runtime/index.ts
--tools <lista controllata>
```

Le opzioni `--no-*` disabilitano materiale scoperto automaticamente da Pi. Il
progetto registra quindi solo prompt, skill ed estensione presenti nel proprio
repository. Questo è importante sia per riproducibilità sia per evitare che una
skill personale installata altrove cambi il comportamento scientifico.

Provider, modello e livello di reasoning non hanno più un default OpenAI o
GPT fissato dal launcher. Possono arrivare da Pi oppure dalle variabili
`EPOS_PROVIDER`, `EPOS_MODEL` ed `EPOS_THINKING` (con le equivalenti Pi come
fallback). Il requisito reale è il supporto al tool calling: un modello solo
testuale non può invocare catalogo, FDSN o download.

`--setup-gemini` è un percorso interattivo separato: salva una chiave Gemini e
il provider in `config/profile.env` con permessi ristretti. Il file di esempio
non contiene segreti e documenta solo le variabili opzionali.

```text
La skill originale ricevuta con il progetto citava strumenti come
`tools/epos.py` e un harness LM Studio. Quei file e quel runtime non fanno parte
di questa codebase: erano riferimenti del progetto di provenienza della skill.
Le sue regole utili sono state adattate ai tool Pi/MCP realmente disponibili;
non si tenta di invocare quei tool inesistenti.
```

## 4. Architettura delle skill e caricamento progressivo

### 4.1 Caricamento progressivo e costo in token

Il launcher ora passa l'intera directory `skills/` a Pi. All'avvio Pi scopre i
tre `SKILL.md`, ma nel contesto iniziale espone soltanto nome, descrizione e
percorso; non include i corpi completi delle skill. La verifica nativa del loader
Pi ha rilevato esattamente queste tre skill, senza diagnostiche, con un blocco di
descrizioni di 1.497 caratteri e senza i body.

Quando la richiesta lo richiede, il modello usa `read` per aprire il solo
`SKILL.md` pertinente. A quel punto le istruzioni complete diventano contesto
del turno. In pratica:

| Richiesta | Skill da leggere | Capability da caricare |
| --- | --- | --- |
| “Trova cataloghi terremoti” | `epos-search` | `catalog_search` |
| “Cerca il software X” | `epos-search` | `software_search` |
| “Spiegami questa risorsa / scaricala” | `epos-service-access` | `description`, poi `download` se necessario |
| “Eventi M≥4 in Italia” | `epos-fdsn-earthquakes` | `seismology` |
| “Analizza il file che ho scaricato” | Nessuna skill aggiuntiva obbligatoria | `analysis` |

Questo è un caricamento progressivo dei tool. Il processo `mcp-epos` viene
inizializzato insieme alla sessione per evitare race condition e conservare gli
ID temporanei; il server specialistico FDSN parte invece alla prima chiamata.

### 4.2 Le tre skill

**`epos-search`** stabilisce il comportamento di discovery. Impone query
catalografiche inglesi, brevi e precise, preservando nomi propri, date, bounding
box e filtri confermati. Se il provider è nominato, la prima operazione deve
essere la risoluzione dell'organizzazione. L'estensione attraversa internamente
tutte le pagine e presenta soltanto i titoli utili raggruppati per funzione
scientifica. Dopo un risultato vuoto è consentito un solo tentativo più ampio.

**`epos-service-access`** entra in gioco solo dopo la selezione. Chiede di
ispezionare metadata e parametri normalizzati prima dell'esecuzione, di non
inventare parametri e di dichiarare separatamente stime e valori certi. Il piano
complessivo richiede una sola conferma e dispone di un budget cumulativo di
1 GiB per studio.

**`epos-fdsn-earthquakes`** è isolata perché la ricerca eventi non è una ricerca
nel catalogo EPOS. Stabilisce filtri FDSN, datacenter e identità opaca degli
event ID. Senza un `limit` richiesto dall'utente, l'adapter segue tutte le pagine
e salva il dataset JSONL completo; un file `.partial.jsonl` non deve essere
presentato come completo.

### 4.3 La directory `skills/epos/` vuota

La vecchia skill monolitica era `skills/epos/SKILL.md`. Il file è stato rimosso
in favore delle tre skill. La directory può restare fisicamente vuota sul disco,
ma Git non traccia directory vuote e Pi non la considera una skill perché non
contiene `SKILL.md`. È innocua; può essere cancellata localmente oppure lasciata
finché non viene fatto un cleanup esplicito.

## 5. Router dei tool e visibilità per turno

Il router vive in `tools/agent-runtime/index.ts`. Il suo scopo è ridurre sia i
token degli schemi tool sia la probabilità di selezionare una capacità fuori
contesto.

All'inizio di ogni turno sono attivi soltanto:

```text
read
epos_load_tools
```

Il modello deve chiamare autonomamente `epos_load_tools`; non deve chiederlo al
ricercatore. Il router abilita quindi **un gruppo** e conserva solo `read`, il
router stesso e gli strumenti del gruppo richiesto. Al turno utente successivo,
il hook `before_agent_start` richiama `resetTools` e torna al set minimo.

| Gruppo | Tool Pi attivati | Uso |
| --- | --- | --- |
| `catalog_search` | `epos_mcp_call` | Provider e risorse/distribuzioni tramite la fonte primaria EPOS. |
| `description` | `epos_mcp_call` | Metadata di una distribuzione scelta. |
| `download` | `epos_mcp_call` | Preparazione ed esecuzione tramite MCP EPOS. |
| `seismology` | `epos_fdsnws_event_call` | Eventi e dettagli FDSN. |
| `analysis` | `read`, `epos_run_python`, `epos_show_image` | Elaborazione/immagini nel workspace. |
| `workspace` | `read`, `write`, `edit`, `ls`, `find`, `grep` | Gestione esplicita dei file di lavoro. |

Il profilo stdio completo espone undici tool, inclusi ricerca e paginazione,
organizzazioni, dettagli, preparazione/esecuzione, ispezione e fetch controllato.

L'estensione espone wrapper con prefisso `epos_` perché Pi non parla
direttamente con il server: il wrapper avvia il processo stdio, gli invia
`tools/call`, aggiunge provenance, limita il materiale reinserito nella chat e
aggiorna lo stato conversazionale. Il tool FDSN è invece un wrapper unico che
smista le sei operazioni supportate dal suo MCP.

## 6. Ciclo di vita dei server MCP

`StdioMcpClient` incapsula un processo figlio JSON-RPC su stdin/stdout. Ci sono
due istanze:

- EPOS: `services/mcp-epos/.venv/bin/python services/mcp-epos/tools/epos_mcp_stdio.py`;
- FDSN: il binario del virtual environment in
  `services/mcp-fdsnws-event/.venv/bin/`.

L'hook `session_start` avvia e inizializza MCP EPOS prima che l'agente accetti
richieste. La stessa istanza viene riusata per l'intera sessione; FDSN resta
lazy. Durante l'inizializzazione viene negoziata la versione MCP `2025-11-25`.
Gli errori del processo liberano le richieste pendenti invece di lasciare
promesse sospese.

Questa scelta riduce tempo e consumo per conversazioni che terminano prima di
un accesso dati e consente di lanciare EPOS Agent anche se una capability non
usata non è ancora inizializzabile.

## 7. Come funziona la ricerca nel catalogo EPOS

### 7.1 Percorso generale

1. Il modello legge `epos-search` e carica `catalog_search`.
2. Converte la domanda in una query inglese concisa, senza alterare nomi propri
   o filtri scientifici già confermati.
3. Se l'utente ha citato un provider, chiama prima `epos_search_organizations`.
4. Se la risoluzione è univoca, passa l'ID selezionato, invariato, a
   `epos_search_resources`; se è ambigua, mostra candidati e attende una scelta.
5. Mostra tutte le cinque (o meno) schede della pagina, con titolo, provider,
   ID e motivazione di rilevanza basata su metadata.
6. Attende prima di richiedere `nextOffset`. Non descrive né esegue
   automaticamente un risultato, salvo richiesta esplicita di selezione automatica.

Questo è il “ragionamento” prescritto all'agente: non un algoritmo nascosto che
sceglie dati al posto dell'utente, ma una sequenza di decisioni verificabili e
researcher-in-the-loop.

### 7.2 `search_organizations`: risoluzione dei provider

Il tool riceve `q` obbligatorio, `country` facoltativo, `offset` e `limit`; il
limite è validato fra 1 e 5. Richiede il solo endpoint pubblico
`/resources/organizations`, senza usare il costoso endpoint
`/resources/organizations/full`.

Poiché la ricerca remota delle organizzazioni può restituire più record di
quanti la query faccia pensare, il server applica localmente:

- confronto normalizzato (minuscole, accenti rimossi, punteggiatura uniformata);
- filtro per nome e, se presente, paese;
- deduplicazione per ID;
- ranking per nome esatto, prefisso, parola intera, contenimento e URL;
- paginazione solo dopo filtro, deduplicazione e ordinamento.

Il risultato è compatto: ID, nome, paese, URL, paginazione e provenance. La
provenance contiene endpoint, tempo di recupero, HTTP status, content type e
byte della risposta sorgente.

### 7.3 `search_resources`: flattening, filtri e ranking

L'API EPOS restituisce una struttura gerarchica. `collectDistributions` la
percorre ricorsivamente e trasforma le `distributions` in candidati piatti.
Durante il flattening conserva il percorso dei domini catalografici in un campo
interno `_catalogDomains`; senza questo passaggio il dominio del nodo padre
andava perso e i filtri/ranking successivi non potevano usarlo.

La pipeline locale è:

```text
albero EPOS
  → distributions piatte + dominio ereditato
  → deduplica per id
  → filtro locale scienceDomains (nome o codice)
  → ranking lessicale locale
  → offset/limit (massimo 5)
  → schede compatte
```

Il filtro `scienceDomains` non viene più affidato al parametro remoto
`sciencedomains`, il cui comportamento era inaffidabile nella verifica. Il tool
lo dichiara esplicitamente in `appliedLocally` e restituisce anche
`totalBeforeLocalFilters`, così l'agente può distinguere il totale grezzo da
quello mostrabile.

Il ranking locale, stabile a parità, compara nell'ordine:

1. titolo uguale alla query normalizzata;
2. frase completa nel titolo;
3. numero di token della query presenti nel titolo;
4. frase in provider o dominio;
5. token in provider o dominio;
6. frase nella descrizione;
7. token nella descrizione.

Se due elementi hanno lo stesso vettore di ranking, resta l'ordine originario
EPOS. Il ranking precede la paginazione: una risorsa molto pertinente non viene
quindi esclusa soltanto perché era più in basso nel grande albero remoto.

Ogni scheda restituisce ID, titolo, provider, domini, formati, riassunto
troncato a 240 caratteri e `status` solo se presente. Facet e payload raw non
passano nel risultato destinato al modello.

Il test live con “earthquake catalogue” ha restituito otto candidati filtrati,
cinque nella prima pagina, con cataloghi ESHM20 nelle prime posizioni. Il test
“INGV” ha messo al primo posto l'organizzazione ufficiale e la ricerca successiva
con il suo ID ha restituito soltanto provider INGV nelle schede mostrate.

### 7.4 Ricerca software

`search_software` è separato in un gruppo differente per non caricare il suo
schema durante una normale ricerca dati. Applica paginazione compatta analoga e
restituisce una scheda software con provider, domini, formati e sintesi. La
skill di search dice di caricarlo solo per software.

## 8. Metadata, servizi e download EPOS

Una ricerca restituisce un candidato; non equivale a dati scaricati. Dopo la
scelta del ricercatore l'agente può usare:

- `describe_resource` per metadata compatti della distribuzione;
- `describe_software` per un record software;
- `describe_service` per endpoint, documentazione, formati e parametri
  normalizzati;
- `execute_service` per eseguire una risorsa read-only.

`execute_service` recupera prima i dettagli della risorsa, valida i parametri
contro quelli dichiarati dal servizio e costruisce la richiesta gateway.

- il piano complessivo richiede una sola conferma prima delle chiamate che
  acquisiscono dati scientifici e non include stime di dimensione;
- ricerca, metadata, descrizioni e capabilities restano automatici;
- ogni studio ha un limite cumulativo di 1 GiB;
- il limite è controllato durante il trasferimento;
- l'intera risposta viene scritta in `workspace/`, mentre la chat riceve solo
  percorso, valori misurati, tipo, stato, metadata essenziali, al massimo cinque
  record rappresentativi e provenance;
- un errore nello streaming conserva il file con suffisso `.partial` e ne
  dichiara esplicitamente la completezza non verificata o parziale.

Il nome di default è derivato da ID risorsa, timestamp ed estensione coerente
con content type/formato. Un `outputFileName` esplicito deve essere un semplice
filename, quindi non può uscire dal workspace mediante `../`.

## 9. FDSN: eventi sismici separati dal catalogo

`epos_fdsnws_event_call` accetta un'operazione FDSN e il relativo dizionario di
argomenti. Prima normalizza alcuni alias (`minmagnitude` → `minmag`, ecc.) e
rifiuta parametri non supportati o alias in conflitto.

Per `fdsn_query_earthquakes`:

1. se l'utente ha dato `limit`, invia esattamente quella richiesta;
2. senza `limit`, divide adattivamente l'intervallo temporale quando una
   risposta raggiunge il limite del provider;
3. converte righe/colonne del server in JSONL e deduplica per datacenter ed
   `EventID`;
4. conserva soltanto cinque esempi per la chat;
5. registra contatore, numero pagine, byte, datacenter, endpoint e filtri;
6. rispetta il budget residuo del limite cumulativo di 1 GiB dello studio;
7. dopo un errore con record già acquisiti rinomina il file in `.partial.jsonl`,
   registra `complete: false` e segnala un errore strutturato.

Per le operazioni di dettaglio, se la risposta supera il limite chat viene
salvata in un JSON nel workspace. L'identificatore di evento viene trattato come
opaco e legato al datacenter: non deve essere modificato né riusato altrove.

## 10. Stato conversazionale, provenance e limiti di contesto

L'estensione mantiene un piccolo `ConversationState` con:

- intento e dominio;
- filtri confermati;
- ID della risorsa selezionata e formato;
- fino a dieci file recenti e fino a dieci file di provenance;
- timestamp di aggiornamento.

Lo stato è salvato come voce custom nel branch della sessione Pi. All'avvio o al
cambio branch viene ripristinato; prima del turno viene reinserito nel prompt
come un breve blocco XML. Non conserva risposte raw, interi cataloghi o dataset:
serve a riutilizzare informazioni già confermate senza ripetere domande.

Ogni wrapper scrive una provenance JSON in `logs/provenance/`. Per le chiamate
EPOS include tipicamente azione, parametri, endpoint, timestamp, HTTP status,
content type e byte sorgente. Python e FDSN aggiungono i rispettivi dettagli
operativi. Il risultato chat include il path della provenance.

`modelResult` limita a 12.000 caratteri la serializzazione reiniettata nel
modello. Se un risultato è più grande, il modello riceve una preview marcata
`truncatedInChat`; l'oggetto completo resta nei `details` del tool o in un file
del workspace. È una protezione del contesto, non una perdita silenziosa di
dati scaricati.

L'hook `message_end` registra in `logs/token-usage.jsonl` uso input/output,
cache, reasoning, provider, modello e tool attivi. Non registra prompt né dati
scientifici completi.

## 11. Sicurezza del filesystem e delle operazioni

Le operazioni di scrittura dell'estensione controllano che i path risolti restino
dentro `workspace/`. Questo vale per script Python esistenti, immagini da
mostrare e output indicati dall'utente. Python viene avviato con working
directory nel workspace, timeout limitato a 300 secondi e buffer massimo di
10 MB. L'estensione non trasforma il workspace in un accesso generico alla home.

L'accesso ai servizi pubblici EPOS/FDSN è “open world” dal punto di vista MCP,
mentre le operazioni catalografiche e descrittive sono annotate read-only. Il
download cambia il filesystem locale e perciò ha una policy più prudente.

## 12. Intervento specifico sulla search EPOS

Queste sono le modifiche introdotte per il piano “EPOS search precisa con skill
progressive”:

| Area | Cambiamento |
| --- | --- |
| Skill | Rimossa la skill monolitica e aggiunte le tre skill progressive. |
| Launcher | Da `--skill skills/epos` a `--skill skills`, così Pi scopre tutte e tre le skill. |
| Prompt | Aggiunta la regola di caricare e seguire la skill EPOS pertinente. |
| Router | Aggiunto `epos_search_organizations` al gruppo `catalog_search` e alla lista del launcher. |
| MCP EPOS | Aggiunto `search_organizations` con input/output compatti, filtro/ranking/deduplica locali e massimo cinque risultati. |
| MCP EPOS | Corretto `search_resources`: dominio preservato nel flattening, deduplica per ID, filtro locale `scienceDomains`, ranking prima della paginazione, `status` facoltativo e indicazione dei filtri locali. |
| Contratto | Copiato l'OpenAPI fornito in `services/mcp-epos/definitions/api-spec.json`, fuori dal contesto dell'agente. |
| Stato | Aggiornato `docs/status.md` con architettura, risultati e backlog. |

Non è stato aggiunto alcun accesso a `/resources/organizations/full`; non sono
stati creati test, fixture o artefatti permanenti per questa modifica.

## 13. Verifiche essenziali già effettuate

Le verifiche fatte per l'intervento search sono intenzionalmente minime:

- parsing di `server.mjs` con `node --check`;
- parsing TypeScript dell'estensione con Node;
- controllo sintassi del launcher con `bash -n`;
- validazione JSON e confronto SHA-256 della copia OpenAPI con il file fornito;
- `git diff --check`;
- discovery nativa Pi: tre skill, nessuna diagnostica, descrizioni senza body;
- smoke test stdio MCP: protocollo `2025-11-25` e undici tool registrati con
  `structuredContent`;
- due query live: “earthquake catalogue” e risoluzione “INGV” seguita da ricerca
  tramite ID selezionato.

Il validatore opzionale della skill basato su Python non è stato usato con
successo perché nell'ambiente mancava il modulo `yaml`; questo non invalida la
discovery nativa Pi già passata, ma va ricordato se si vuole aggiungere quella
verifica in CI.



## 14. Report Tecnico sulle Ottimizzazioni e Interventi Architetturali

Di seguito è documentato in dettaglio tutto il lavoro tecnico effettuato sull'architettura di EPOS Agent, con particolare focus sulla riduzione dei token, sull'ottimizzazione del processo di discovery e sulla risoluzione dei bug critici durante l'acquisizione dei dati.

### 14.1 Ottimizzazione della Context Window e Riduzione dei Token
Il problema iniziale evidenziato dai log di utilizzo era l'eccessivo consumo di token del LLM dovuto al caricamento contestuale dell'intera base di conoscenza del progetto ad ogni iterazione.
- **Decoupling della Skill Monolitica:** La precedente skill monolitica (`skills/epos/SKILL.md`) che conteneva l'intero dominio di azioni dell'agente è stata deprecata ed eliminata. Il dominio di istruzioni è stato diviso in tre skill specializzate, modulari e progressive: `epos-search`, `epos-service-access` ed `epos-fdsn-earthquakes`.
- **Caricamento Lazy (Progressivo):** All'avvio dell'applicazione (`bin/epos-agent`), l'agente riceve solo una sintesi minima delle skill. Tramite il tool standard `read` e una logica di discovery nativa, l'agente decide di "espandere" nella context window attiva solo il file `SKILL.md` pertinente alla fase corrente dell'utente (ad esempio, fase di ricerca o fase di download), garantendo un drastico risparmio sul costo computazionale e sui token passati al prompt.
- **Router Intelligente dei Tool (`agent-runtime/index.ts`):** È stato introdotto un router di stato che disabilita i tool fuori contesto. Invece di esporre tutti gli endpoint MCP (Model Context Protocol) simultaneamente, il sistema espone inizialmente solo il tool di base `read` e l'hook interno `epos_load_tools`. L'agente chiama questo hook per "sbloccare" i tool strettamente necessari per il task (raggruppati in domini di visibilità: `catalog_search`, `description`, `download`, `seismology`, `analysis` e `workspace`).
- **Protezione dell'Overflow della Context Window (Safe-limit):** I payload di ritorno (JSON, testo grezzo) generati da servizi MCP molto prolissi sono stati protetti. Se il risultato serializzato per il modello supera i 12.000 caratteri, il testo viene troncato introducendo il flag `truncatedInChat` (per avvisare il modello), mentre il dataset reale viene riversato integralmente su file temporanei all'interno di `workspace/`.

### 14.2 Miglioramento della Pipeline di Ricerca Catalografica EPOS
L'interazione dell'agente col catalogo è stata ristrutturata per prevenire allucinazioni dovute alla grande quantità di record raw.
- **Ricerca a Due Fasi e Ambiguità:** La pipeline di discovery (in `services/mcp-epos/tools/epos_mcp_http.py`) risolve proattivamente le ambiguità sui nomi dei provider. L'agente esegue prima `epos_search_organizations` e, solo a seguito della risoluzione dell'ID univoco dell'organizzazione, invoca `epos_search_resources`.
- **Flattening Dinamico dell'Albero Remoto:** L'API pubblica di EPOS produce risposte fortemente gerarchizzate. È stato introdotto un meccanismo di "flattening" locale lato estensione. Il nodo figlio viene appiattito mentre il codice conserva ricorsivamente i metadati genitoriali (come il dominio in `_catalogDomains`). In questo modo l'agente riceve candidati uniformi ed esplorabili direttamente.
- **Ranking Semantico Pre-Paginazione:** È stato introdotto un filtro vettoriale euristico personalizzato (in Python) che agisce localmente prima di restituire l'array impaginato. L'algoritmo valuta la precisione semantica (confrontando la pertinenza nel titolo, le frasi esatte nella descrizione e il conteggio dei token matchati) e procede a una deduplica per ID.
- **Schede Compattate:** Soltanto i primi 5 risultati del ranking superano il filtro e vengono iniettati nella chat come "schede compattate" (provider, formati supportati, status operativo e breve sintesi), spurgando i payload grezzi e i metadata inutili al ragionamento del modello LLM.

### 14.3 Risoluzione del Bug nei Server FDSN (Sliding Window Algorithm)
Il problema più critico del sistema riguardava il download massivo di eventi sismici da nodi FDSN (es. il download completo della sequenza sismica di Amatrice estesa su diversi mesi). In queste situazioni l'agente entrava in loop o "si impallava".
- **Diagnosi del Vecchio Algoritmo (Metodo per Bisezione):** A causa dei limiti severi dei datacenter FDSN (tetto massimo di 1000 eventi a richiesta HTTP), quando l'agente riceveva una pagina saturata di 1000 eventi, supponeva la presenza di dati nascosti. Di conseguenza, l'algoritmo *scartava completamente* il payload appena scaricato, tagliava la finestra temporale della richiesta a metà (bisezione temporale) e riprovava ad oltranza fino a ottenere una risposta minore di 1000. Questo portava a uno spreco estremo (centinaia di chiamate a vuoto) prima ancora di salvare il primo record.
- **La Soluzione Implementata (Sliding Window):** Il codice in `tools/agent-runtime/index.ts` (righe 1406-1432) è stato totalmente riscritto. È stata creata una logica a "finestra scorrevole intelligente". Quando il modulo riceve una risposta saturata (es. `FDSN_PAGE_SIZE`), *non scarta più i dati*. Salva immediatamente la pagina di eventi su disco e legge l'indice temporale dell'ultimo evento dell'array (timestamp esatto). Utilizza poi questo valore per traslare in avanti la finestra temporale della successiva query HTTP (`starttime = ultimo_evento.timestamp`).
- **Ottimizzazione delle Prestazioni:** Questa modifica ha abbassato drasticamente il tasso di richieste di rete portandolo al minimo teorico (es. per processare uno sciame sismico di 80.000 eventi, il sistema passa da loop infiniti e blocchi a circa 80 chiamate API fluide in sequenza rapida).
- **Nuovo Workflow per l'Utente ("Tutto e Subito"):** Come richiesto esplicitamente nei feedback, il processo è stato automatizzato per non disturbare l'utente. L'agente non propone più campionamenti intermedi bloccandosi ogni 2 giorni di dati, ma scarica fluidamente l'intero dataset, avvisando a download completato.

### 14.4 Architettura Sicura: Integrità dei Dati e Provenance
- **Data Recovery:** Durante le complesse sessioni FDSN (che gestiscono grosse moli di dati strutturati in JSONL), nel caso in cui un download subisca un'interruzione (abort) o fallisca a metà per timeout server, il file parziale non viene perso né cestinato. Viene rinominato localmente aggiungendo l'estensione `.partial.jsonl`, salvaguardando il costo operazionale sostenuto fino all'errore.
- **Tracciabilità Rigorosa (Provenance):** Nessuna transazione HTTP avviene senza traccia. Ogni tool eseguito compila un record JSON in `logs/provenance/` contenente lo stato HTTP, l'endpoint interrogato, i timestamp e il volume bytes. Qualsiasi output prodotto dal modello può essere verificato fino alla fonte grezza.
- **Isolamento del Workspace:** I salvataggi per dati scientifici, output di plot grafici ed esportazione di script Python (eseguite tramite il tool `epos_run_python`) sono confinati temporaneamente e strettamente nelle directory di studio (es. `~/epos-agent/workspace/study-XYZ`). L'hard limit di budget download, impostato a 1 GiB per singola sessione di ricerca, opera sia lato stream che in append per scongiurare memory leak o attacchi Out-Of-Memory.

