# How Human Memory Works

*A research synthesis to inform a redesign of an LLM agent memory system.*
*This document covers the human side only. No software design is proposed here.*
*Inline italic notes flag tempting analogs without elaborating on them.*

---

## 0. Why this document exists

The pantheon project maintains an "agent memory" abstraction whose vocabulary
(append, fade, forget, recall, summary/text/details) was originally chosen by
informal analogy to human memory. Before redesigning that abstraction, it is
worth grounding ourselves in what biological memory actually is — not the
folk-psychology version, not the marketing-deck version ("episodic / semantic /
procedural" tossed around as if those terms were uncontested), but the
research-grounded picture, including the places where neuroscience is honest
about not yet knowing.

The headline finding from a survey of the literature is this: **human memory
is not one system, it is many systems, and most of what we call "memory"
behaviour is actually the interaction between them.** A second headline,
nearly as important: **forgetting is not failure. It is an active, regulated,
adaptive function.** Both points will recur throughout the doc.

---

## 1. Memory taxonomy: many systems, not one

The dominant taxonomy in cognitive neuroscience descends from Larry Squire's
synthesis of decades of lesion and neuroimaging work (Squire 2004,
[paper](http://whoville.ucsd.edu/PDFs/384_Squire_%20NeurobiolLearnMem2004.pdf)).
At the top level it divides long-term memory into **declarative** (conscious,
"knowing that") and **non-declarative** (unconscious, "knowing how").
Declarative memory then splits into **episodic** (specific events you lived
through) and **semantic** (general facts about the world), a distinction
originally articulated by Endel Tulving (Tulving 1972; Renoult & Rugg 2020,
[paper](https://pubmed.ncbi.nlm.nih.gov/32007511/)).
Non-declarative memory contains procedural skill, priming, simple classical
conditioning, and non-associative learning.

Layered on top of this long-term taxonomy is a separate axis of **time-scale**:
sensory memory (milliseconds), short-term / working memory (seconds), and
long-term memory (minutes to a lifetime). The classic Atkinson–Shiffrin
"multi-store" framing treats these as sequential buffers, but Craik &
Lockhart's levels-of-processing critique (see §2) and Baddeley's working-memory
model (see §3) showed that the picture is more like multiple, partially
independent stores with different codes, capacities, and decay profiles.

The reason this matters: **double dissociations**. Patient H.M., after
bilateral hippocampal resection, could no longer form new declarative
memories but could still learn new motor skills he never recalled practising
(Squire 2004). Procedural and declarative memory live in different brain
systems and break apart under different lesions. Conversely, patients with
basal-ganglia disease can show preserved declarative memory and impaired
procedural learning. Tulving himself emphasised that episodic and semantic
memory, though dissociable, are also deeply interdependent — semantic
knowledge is the substrate against which episodes are encoded, and episodes
are the raw material from which semantic knowledge is abstracted (Renoult &
Rugg 2020, [paper](https://pubmed.ncbi.nlm.nih.gov/32007511/);
Greenberg & Verfaellie 2010,
[paper](https://pubmed.ncbi.nlm.nih.gov/20561378/)).

A useful contemporary refinement: episodic and semantic memory are best
thought of as the endpoints of a continuum of representational specificity,
not as discrete bins. Most real memories are "semantic-with-episodic-traces"
or "episodic-becoming-semantic" — the boundary is fuzzy and the brain moves
content across it over time (Renoult & Rugg 2020).

*Analog for agent memory: different timescales and access modes probably
need different storage and rendering paths, not one uniform store.*

### Sensory memory

The shortest-lived tier. Sperling's classic partial-report experiments
(Sperling 1960,
[paper](https://sites.socsci.uci.edu/~whipl/staff/sperling/PDFs/Sperling_PsychMonogr_1960.pdf))
showed that a brief visual array (e.g. 12 letters flashed for 50 ms) is
initially almost fully available — subjects could report any cued row at
75% accuracy — but this rich representation decays within ~250 ms unless
some of it is read into short-term memory. Iconic memory (visual), echoic
memory (auditory), and analogous brief stores for other modalities are the
"raw input buffer" of cognition: high-bandwidth, sensory-format,
near-instantly forgotten.

The functional point is that the bottleneck between sensation and durable
memory is not storage — sensory memory holds far more than survives — it is
**selective transfer**. Attention chooses what crosses the gap, and
everything else is gone in a quarter-second.

*Analog for agent memory: not everything the agent perceives in a turn
needs to be persisted; in fact most of it should evaporate.*

---

## 2. Encoding: what determines whether something enters memory at all

Memory is not a passive recorder. Whether an experience becomes a durable
trace depends on how it was processed during encoding.

**Levels of processing.** Craik & Lockhart's 1972 framework
([paper](http://wixtedlab.ucsd.edu/publications/Psych%20218/Craik_Lockhart_1972.pdf))
proposed that retention is a function of the *depth* of processing applied
to a stimulus, on a continuum from shallow (sensory features: what does
this word look like?) through intermediate (phonemic: what does it sound
like?) to deep (semantic: what does it mean, how does it relate to what I
already know?). Deep processing produces dramatically better retention,
even when shallow processing involves more time or rehearsal. The
framework's specific staging has been criticised, but the core empirical
finding — semantic engagement beats sensory rehearsal — has held up across
half a century of replication.

**Attention.** Without attention, encoding is feeble or absent. The
classic "inattentional blindness" demonstrations are extreme cases, but
the everyday version is that distracted encoding produces fragile
memories. This is mediated in part by hippocampal and prefrontal gating;
the hippocampus does not faithfully copy everything in the sensory stream,
it preferentially binds what is attended.

**Emotional arousal.** Emotionally salient experiences are remembered
better and longer than neutral ones, and this is not just because they
attract attention. McGaugh's body of work
([McGaugh 2004, Annual Reviews](https://www.annualreviews.org/content/journals/10.1146/annurev.neuro.27.070203.144157))
established that adrenal stress hormones (epinephrine, cortisol) released
during emotional arousal feed back onto the basolateral amygdala, which
in turn modulates consolidation in the hippocampus, striatum, and cortex.
The amygdala does not store the emotional memory itself — it tags whatever
*else* is being encoded as "important, protect from forgetting." This is
why people remember where they were on 9/11 in a way they do not remember
where they were on the previous Tuesday.

**Prediction error / surprise.** A more recent line of work shows that
**surprise — the gap between what was expected and what occurred — is a
powerful driver of encoding and updating**
(Sinclair et al. 2021, [PNAS paper](https://www.pnas.org/doi/10.1073/pnas.2117625118);
Rouhani et al. 2018,
[Nature Human Behaviour](https://www.nature.com/articles/s41562-019-0597-3)).
Prediction errors trigger phasic dopamine release from the ventral
tegmental area into the hippocampus, which modulates plasticity. Small
prediction errors tend to *update* existing memories; large ones tend to
*spawn new* episodic traces. The brain has a built-in surprise threshold
that decides whether new experience is a variant of an existing schema
or a new thing altogether.

**Repetition vs elaboration.** Rote repetition produces some encoding
benefit but is dramatically inferior to *elaborative* rehearsal —
connecting new material to existing knowledge, generating examples, asking
why. This is a direct consequence of the levels-of-processing principle:
elaboration forces semantic engagement.

*Analog for agent memory: a write is not just "store this string"; it is a
decision modulated by salience, surprise, and connectability to existing
content. Indiscriminate writing degrades the whole.*

---

## 3. Short-term / working memory

Working memory is the active, manipulable buffer that holds the contents
of current thought. The dominant theoretical framework is Baddeley and
Hitch's multi-component model
(Baddeley & Hitch 1974; revised Baddeley 2000;
[fifty-years review, Hitch, Allen & Baddeley 2025](https://journals.sagepub.com/doi/10.1177/17470218241290909);
[Wikipedia overview](https://en.wikipedia.org/wiki/Baddeley%27s_model_of_working_memory)).
Its components:

- **Phonological loop** — a verbal/acoustic buffer that holds ~2 seconds
  of inner speech, refreshed by subvocal rehearsal. Implicated in language
  comprehension and vocabulary acquisition.
- **Visuospatial sketchpad** — a parallel buffer for visual and spatial
  imagery. Independent from the loop (you can rehearse a phone number
  while visualising a route).
- **Central executive** — attentional control, manipulation, switching
  between subsystems. Not a store, a controller.
- **Episodic buffer** (added in Baddeley 2000) — a limited multi-modal
  workspace that binds information from the loop, sketchpad, and long-term
  memory into coherent episodes. It is the place where the "now" of
  experience is assembled.

**Capacity.** George Miller's "magical number seven plus or minus two"
(1956) was a rhetorical estimate that has been substantially revised
downward. Nelson Cowan's analysis
([Cowan 2001, BBS](https://www.cambridge.org/core/journals/behavioral-and-brain-sciences/article/magical-number-4-in-shortterm-memory-a-reconsideration-of-mental-storage-capacity/44023F1147D4A1D44BDC0AD226838496);
[PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC2864034/))
argues that true working-memory capacity, controlling for chunking and
rehearsal strategies, is closer to **~4 chunks** in young adults. Miller's
seven was inflated by participants spontaneously chunking digits or
letters into larger units. The real bottleneck is around four
*independent* items.

**Duration.** Items in the phonological loop decay in roughly 2 seconds
unless refreshed. Without rehearsal, working memory empties fast.

**What lives there.** Working memory is the substrate of current
reasoning, comprehension, planning, and problem solving. It is *not* a
copy of long-term memory; it is a workspace where pointers into long-term
memory are activated, manipulated, and combined. Damage to working memory
(e.g. in some prefrontal lesions) produces difficulty *acting* on
knowledge even when the knowledge itself is intact.

**Long-term working memory.** Ericsson & Kintsch's extension
(reviewed in Gobet 1998,
[paper](https://pubmed.ncbi.nlm.nih.gov/9677761/))
proposes that experts can effectively use a portion of long-term memory
as if it were working memory, via fast retrieval of well-organised
representations. A grandmaster does not hold a chess position in a 4-chunk
buffer; they hold a pointer to a template in long-term memory that
*unpacks* into the full position. This will recur in §9.

*Analog for agent memory: the "active context" of a turn is small, fast,
and lossy; durable storage is something else. They have different rules.*

---

## 4. Consolidation: short-lived traces becoming durable

A newly encoded memory does not arrive at its final state. It is
**consolidated** over time — at two distinct scales.

**Synaptic consolidation** happens on the order of minutes to hours.
Newly induced synaptic changes (the leading candidate mechanism is
long-term potentiation, LTP) require a cascade of NMDA-receptor-driven
calcium influx, CaMKII activation, gene expression, and protein synthesis
to stabilise. Interruption of protein synthesis in this window blocks
long-term memory formation
([Long-Term Potentiation review, ScienceDirect](https://www.sciencedirect.com/topics/neuroscience/long-term-potentiation);
[NCBI Bookshelf chapter](https://www.ncbi.nlm.nih.gov/books/NBK10878/)).
However — and this is important for honesty about uncertainty —
the equation "LTP = memory storage" is not settled. Bliss, Collingridge
& Morris's history of the field
([Bliss & Cooke 2011](https://pubmed.ncbi.nlm.nih.gov/32442358/))
and Abraham et al.'s npj Science of Learning review
([Is plasticity the mechanism of long-term memory storage?](https://www.nature.com/articles/s41539-019-0048-y))
both note that while LTP is the best-developed model and the correlations
with learning are extensive, *the causal claim that LTP is how memories
are physically stored is supported but not proved*. We will return to
this in §11.

**Systems consolidation** happens over days to years. This is the slow
transfer of memory dependence from the hippocampus to the neocortex. The
canonical computational framing is McClelland, McNaughton & O'Reilly's
**Complementary Learning Systems** theory
([McClelland, McNaughton & O'Reilly 1995](https://stanford.edu/~jlmcc/papers/McCMcNaughtonOReilly95.pdf);
updated in [Kumaran, Hassabis & McClelland 2016](https://pubmed.ncbi.nlm.nih.gov/27315762/)):

- The **hippocampus** is a sparse, pattern-separated system that can
  bind arbitrary co-occurrences into an episodic trace in a single
  exposure. Its representations are quasi-orthogonal — distinct events
  do not interfere — but its capacity is bounded.
- The **neocortex** is a distributed, overlapping system that learns
  *slowly*, by integrating across many episodes to extract regularities.
  Its representations are statistical and compressed; what is in the
  cortex is general knowledge.
- During wake-experience the hippocampus indexes the cortical pattern of
  the moment. During sleep (especially slow-wave sleep, see §7) the
  hippocampus *replays* those patterns to the cortex, which slowly
  re-tunes its weights to incorporate them. After many replays, a memory
  becomes retrievable from cortex alone and no longer requires the
  hippocampal index.

This division of labour solves the **stability–plasticity dilemma**:
the cortex would catastrophically interfere with old knowledge if it
tried to learn one-shot, so a fast, isolated, pattern-separated buffer
(the hippocampus) takes the hit, and the slow cortex absorbs the
content gradually over many interleaved replays.

The standard consolidation model implies that with enough time, the
hippocampus becomes unnecessary for an old memory. This is contested.
Nadel and Moscovitch's **Multiple Trace Theory**
([Moscovitch et al. 2005](https://link.springer.com/article/10.1007/s11559-007-9003-9);
[Nadel et al. 2000](https://pubmed.ncbi.nlm.nih.gov/10985275/))
argues that genuinely *episodic* memories (the rich, autobiographical kind
with context and "you-were-there" flavour) remain hippocampus-dependent
indefinitely — what becomes hippocampus-independent is the *semanticised*
gist. On this view, the cortex extracts and stores the schema; the rich
episode lives in the hippocampus or not at all. The lesion data is
genuinely mixed (Winocur & Moscovitch 2011), and a current synthesis
("Trace Transformation Theory") proposes that consolidation is not just
transfer but *re-representation*: episodes get more semantic, more
schematic, and less spatially-specific with time, even if some
hippocampal trace persists.

*Analog for agent memory: there is plausibly value in a fast, isolated
recent buffer that feeds a slow, integrated long-term store; one-shot
writes to the durable store risk wrecking it.*

---

## 5. Forgetting

Ebbinghaus's 1885 self-experiments produced the canonical **forgetting
curve**: a sharp drop in retention within the first hours after learning,
flattening into a long slow tail. Murre & Dros's 2015 replication
([PLOS ONE](https://pmc.ncbi.nlm.nih.gov/articles/PMC4492928/))
confirmed the original curve's shape closely, with one refinement —
a small uptick at 24 hours, plausibly attributable to a sleep-mediated
consolidation effect. Most forgetting of unstructured material happens
*very fast*, in the first 20 minutes to first day.

Why does forgetting happen? Three non-exclusive theories:

**Decay.** Traces weaken passively over time. There is some evidence
for this at the synaptic level — unrefreshed LTP decays — but pure
decay theories struggle to explain why some memories last for decades
without rehearsal while others vanish in hours.

**Interference.** New learning competes with old, or old with new.
Underwood (1957) argued that most apparent "decay" in laboratory
forgetting was really proactive interference: previously learned
similar material crowded out the new
([interference theory overview, ScienceDirect](https://www.sciencedirect.com/topics/neuroscience/interference-theory);
[Wixted's review](https://uwaterloo.ca/memory-attention-cognition-lab/sites/default/files/uploads/files/interference_theory_4_final_revised.pdf)).
The Müller–Pilzecker tradition focused on retroactive interference: new
material disrupting consolidation of the just-previous learning
([review, PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC2644330/)).
Both effects are real and modulate forgetting heavily depending on
content similarity.

**Retrieval failure.** Tulving's "encoding specificity" principle holds
that retrieval depends on the match between encoding context and
retrieval context. Apparently "forgotten" memories often turn out to be
inaccessible rather than gone — given the right cue, they can come back.
This is the standard explanation for the **tip-of-the-tongue** phenomenon
and for context-dependent recall (you remember something on returning to
the room where you learned it).

In practice, forgetting is almost certainly a mix of all three. The
practically important point is that **forgetting rate depends massively
on what is being forgotten and how**: nonsense syllables decay in hours,
the layout of your childhood kitchen survives decades. The smooth
exponential is an average over wildly heterogeneous content.

*Analog for agent memory: a single TTL or decay constant for all content
is a category error.*

---

## 6. Retrieval and reconsolidation

The classical view treated retrieval as read-only: you peek at the trace,
the trace is unchanged. The modern view, since Karim Nader's lab
demonstrated in 2000 that reactivated fear memories in rats become
labile and require new protein synthesis to re-stabilise, is that
**retrieval modifies the trace**. This is *reconsolidation*.

Nader & Hardt's 2009 *Nature Reviews Neuroscience* paper
([paper](https://www.nature.com/articles/nrn2590))
made the strong case that consolidated memories re-enter an unstable
state when retrieved and must be actively re-stabilised. The clinical
appeal is obvious — if you could retrieve a traumatic memory and
disrupt its reconsolidation, you could attenuate it. Some human studies
(notably Schiller et al. on extinction in the reconsolidation window)
seemed to confirm this.

However: **the human evidence is much more contested than the rodent
fear-conditioning evidence.** A comprehensive review
([Elsey, Van Ast & Kindt 2018](https://psycnet.apa.org/record/2018-22850-001),
referenced in
[Reconsolidation Behavioral Updating review](https://www.fortunejournals.com/articles/reconsolidation-behavioral-updating-of-human-emotional-memory-a-comprehensive-review-and-unified-analysis-to-identify-the-causes-o.html))
catalogues numerous failed replications of human reconsolidation effects
and emphasises that prediction error during reactivation seems to be a
prerequisite — without it, the memory simply re-strengthens rather than
becoming labile. Schwabe et al. 2014 and others have written more
cautiously about reconsolidation as a real-but-narrow phenomenon. So:
reconsolidation is established in well-controlled animal preparations
and in some human fear-learning paradigms; its universality and its
clinical reach are unsettled.

Separately, two robust retrieval-side phenomena affect later retention:

**Testing effect.** Being tested on material produces better long-term
retention than re-studying it for the same time
(Roediger & Karpicke 2006,
[paper](http://psychnet.wustl.edu/memory/wp-content/uploads/2018/04/Roediger-Karpicke-2006_PPS.pdf);
[review, PubMed](https://pubmed.ncbi.nlm.nih.gov/26674128/)).
Retrieval is itself a learning event. Crucially, this only shows up on
*delayed* tests — on immediate tests, re-study often looks better, which
is part of why students underuse self-testing.

**Spacing effect.** Distributed practice beats massed practice for
long-term retention, by a large margin. The mechanism is debated
(encoding variability, study-phase retrieval, deficient processing of
massed repetitions), but the empirical effect is one of the most robust
in cognitive psychology
(Cepeda et al. 2006 meta-analysis,
[paper](http://www.lscp.net/persons/ramus/docs/EPR20.pdf)).
Retention is approximately maximised when the spacing interval is some
fraction (~10–20%) of the desired retention interval.

A useful one-line synthesis: **the act of retrieving a memory is itself
a re-encoding event**, and the conditions of that re-encoding (with or
without feedback, with or without surprise, with or without competing
retrievals) shape what the memory will be next time.

*Analog for agent memory: a read is not free of side effects; how a
memory is rendered and consumed today can change what it is tomorrow.*

---

## 7. Sleep and dreams

A robust finding of the last 30 years: **memory consolidation depends on
sleep**, and the specific role of different sleep stages is partially
understood.

**Slow-wave sleep (SWS / NREM stages 3 and 4)** is dominated by large
cortical slow oscillations (~0.5–1 Hz), thalamo-cortical sleep spindles
(~12–15 Hz), and hippocampal sharp-wave ripples (~150–250 Hz). Wilson &
McNaughton's seminal 1994 *Science* paper
([paper](https://www.weizmann.ac.il/brain-sciences/labs/ulanovsky/sites/neurobiology.labs.ulanovsky/files/uploads/wilson_mcnaughton_reactivationofhippocampalensembleactivity_science_1994.pdf))
showed that place cells in the rat hippocampus that fired together
during waking exploration *replay* their joint firing during subsequent
SWS, at compressed timescales (~20x). This **replay** is the leading
neural correlate of systems consolidation: the hippocampus appears to
retransmit its recent traces to the cortex during SWS, in coordination
with cortical slow oscillations and spindles
(Klinzing, Niethard & Born 2019,
[Nature Neuroscience review](https://www.nature.com/articles/s41593-019-0467-3);
Born et al. various, reviewed in
[Sleep — a brain-state serving systems memory consolidation, ScienceDirect](https://www.sciencedirect.com/science/article/pii/S0896627323002015)).

**REM sleep** is dominated by mixed-frequency, wake-like cortical
activity, theta oscillations in the hippocampus, and skeletal-muscle
atonia. REM appears to play a distinct role: integrating new memories
with existing schemas, promoting creative recombination, and balancing
synaptic renormalization (Stickgold 2005,
[Nature paper](https://www.nature.com/articles/nature04286);
Diekelmann & Born 2010, *Nature Reviews Neuroscience*). The
**sequential hypothesis** holds that SWS extracts and transfers; REM
integrates and abstracts. A recent *Communications Biology* paper
([Liu et al. 2025](https://www.nature.com/articles/s42003-025-08812-3))
finds that SWS preferentially preserves item-level detail while REM
shifts representations toward category-level abstraction — consistent
with the sequential story but adding texture.

**Dreaming** is where well-established science meets serious speculation.
Three families of theory:

- **Memory consolidation / replay.** Dreams partly reflect the brain's
  ongoing consolidation processes; dream content is biased toward
  recent learning and emotional residue. Stickgold's "dream lag effect"
  and the **Tetris dreams** experiments (Stickgold et al. 2000) provide
  empirical support, though correlation between dream content and
  consolidated material is loose.
- **Threat simulation.** Revonsuo (2000) proposes that dreams are an
  evolved offline simulator for rehearsing threat perception and
  avoidance
  ([Valli & Revonsuo 2009, review](https://pubmed.ncbi.nlm.nih.gov/15766897/)).
  Empirical support: dreams are disproportionately negative-themed
  (chase, attack, falling); children with PTSD have higher rates of
  threat content. Main criticism: no direct evidence that dream
  rehearsal improves waking threat performance.
- **Predictive coding / protoconsciousness.** Hobson & Friston
  ([2014, Frontiers in Psychology](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2014.01133/full);
  [Hobson, Hong & Friston, *Waking and dreaming consciousness*](https://pmc.ncbi.nlm.nih.gov/articles/PMC3389346/))
  propose that REM sleep is the brain running its generative world-model
  free of sensory input, optimising it (minimising model complexity)
  by self-generated rehearsal. Dreaming is "the brain talking to itself
  with the inputs unplugged."

A reasonable honest summary: **sleep-dependent consolidation via SWS
replay is well-established. REM's role is well-established but its
mechanism is less specific. The function of dream content per se is
genuinely unsettled.** All three theories of dreaming above have
empirical support, none has decisively won, and they are not entirely
mutually exclusive.

*Analog for agent memory: there appears to be value in an "offline"
phase where recent traces are replayed against, and integrated into,
long-term structure — distinct from the online task-execution mode.*

---

## 8. Language as a special case

A puzzle: most learned content fades within weeks if not rehearsed, but
**the structure of one's native language survives decades of disuse and
substantial neural damage**. Why?

Several factors compound:

**Massive overlearning.** A native language is rehearsed thousands of
times per day for decades. By any consolidation theory, this should
produce extreme cortical entrenchment. The vocabulary, syntax, and
phonology of L1 are some of the most-repeated representations a human
brain ever encodes.

**Distributed cortical representation.** Language is not in one place.
Phonology is in superior temporal cortex; lexical-semantic knowledge
spans much of left temporal and inferior parietal cortex; syntactic
processing involves Broca's area and adjacent regions; semantic
features tile bilaterally with sensorimotor grounding for action and
perception words. This distribution means there is no single point of
failure: focal lesions produce *specific* aphasias (Broca's, Wernicke's,
conduction, anomic) rather than global language loss.

**Procedural overlay.** Much of what makes language fast and automatic
is procedural, not declarative. Ullman's declarative/procedural model of
language argues that grammar (rule-based combination) is supported
largely by procedural memory (basal ganglia, frontal cortex), while the
lexicon is declarative. This is consistent with the dissociations seen
in Alzheimer's disease: regular past-tense morphology (procedural) is
often spared while irregular forms (declarative) decline first
([Language changes in Alzheimer's, ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0093934X21001358);
[Language impairments in AD review](https://www.sciencedirect.com/science/article/pii/S1807593224000899)).

**Sensorimotor grounding and schema density.** Words are anchored to
sensorimotor experience and embedded in extraordinarily dense semantic
networks. Recall of any node is supported by enormous lateral
connectivity. This is consistent with reports that primary progressive
aphasia spares episodic memory for years
([PPA review, PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC3975615/)) —
the *language network* can degenerate while declarative episodic memory
remains intact, and vice versa.

**Bilingual asymmetry.** In bilingual aphasia, L1 (the earlier, more
overlearned language) is typically more preserved than L2
([meta-analysis, PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC6460996/)).
L1 attrition, where speakers immersed in L2 lose access to L1, is real
but slower and more partial than expected — and it primarily affects
production, not comprehension
([First language attrition review, PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC8452950/)).

The big takeaway: **language is durable because it is over-learned,
distributed, procedurally automated, and densely interconnected with
sensorimotor and semantic knowledge.** Nothing one fact-style episode
has any of those properties; that is why facts fade and language
doesn't.

*Analog for agent memory: things that are constantly invoked,
distributed across many representational hooks, and embedded in a
dense web are far more robust than isolated entries.*

---

## 9. Schemas, chunking, and compression

The brain does not store experience verbatim. It compresses it into
**schemas** — abstract structures that capture the regularities across
many episodes — and uses those schemas both to interpret new input and
to reconstruct past experience.

Frederic Bartlett's *Remembering* (1932,
[reconstructive memory overview, Wikipedia](https://en.wikipedia.org/wiki/Reconstructive_memory))
introduced schema theory through the "War of the Ghosts" experiment:
British participants asked to remember a Native American folk tale
systematically distorted the story to fit their cultural schemas,
dropping supernatural elements and rationalising odd transitions.
Bartlett's slogan: remembering is "an imaginative reconstruction, or
construction." There is no veridical trace being read out; instead, a
gist is reconstructed and decorated with schema-consistent detail. This
is the same machinery that produces the **misinformation effect**
(Loftus & Palmer 1974,
[overview, Wikipedia](https://en.wikipedia.org/wiki/Misinformation_effect))
— participants asked about "the broken glass" (which didn't exist) in
a car crash video later "remember" seeing it. The reconstruction is
guided by current expectations, and those expectations can be
implanted.

**Chunking** is the perceptual side of the same idea. Chase & Simon's
1973 chess studies
([Perception in chess](https://andymatuschak.org/prompts/Chase1973.pdf))
showed that chess masters could reconstruct briefly-presented mid-game
positions with remarkable accuracy — *but only when the positions were
real games.* Given random pieces, masters performed no better than
novices. The masters were not using superior raw memory; they were
recognising familiar configurations (chunks: a castled king with intact
pawn shield, a knight outpost) and storing pointers to those
configurations. Estimates suggest grandmasters have **50,000 to 100,000
chess chunks** in long-term memory.

Gobet & Simon's **template theory**
([Gobet 1998, *Cognition*](https://pubmed.ncbi.nlm.nih.gov/9677761/))
extends chunking: chunks that recur often enough evolve into *templates*
with fixed slots and variable slots. A grandmaster does not need to
encode the position fresh; they retrieve a template and fill in the
variations. This is the mechanism behind Ericsson & Kintsch's
**long-term working memory** — domain experts effectively use a portion
of long-term memory as if it were working memory, by virtue of having
fast, well-organised retrieval structures
([Gobet 1998](https://pubmed.ncbi.nlm.nih.gov/9677761/)).

The general principle: **the brain trades episodic fidelity for
compression.** It does not remember every chess game; it abstracts
patterns from many games and remembers those. It does not remember the
exact words of every conversation; it abstracts scripts and remembers
those. Episodic detail is the exception, the marked case, the thing
preserved by salience and prediction error against a much larger
backdrop of schema-driven gist.

*Analog for agent memory: durable memory should look more like learned
templates than verbatim transcripts.*

---

## 10. Forgetting as a feature, not a bug

A memory system that retained everything would be a worse memory system,
not a better one. The recent literature on **adaptive forgetting** makes
this case rigorously.

Simon Nørby's 2015 *Perspectives on Psychological Science* review
([Why forget?](https://journals.sagepub.com/doi/10.1177/1745691615596787))
identifies three adaptive functions of forgetting:

1. **Emotion regulation.** Selective fading of negative material is
   part of how psychological well-being is maintained. Persistent
   intrusive memory (as in PTSD) is pathological precisely because
   the normal fading mechanism is broken.
2. **Knowledge acquisition.** Forgetting the specifics of individual
   episodes is part of how the brain abstracts to semantic and
   procedural knowledge. If every episode remained vivid and
   episodically distinct, generalisation would be impeded.
3. **Context attunement.** Outdated information actively interferes
   with current behaviour. Forgetting old phone numbers, old
   passwords, old configurations of one's home is *useful*; it
   ensures that the most current representations are the most
   accessible.

Anderson & Hulbert's 2021 *Annual Review of Psychology* piece
([Active Forgetting](https://memorycontrol.net/2021Anderson.pdf))
reviews the **active** machinery of forgetting — not passive decay, but
top-down prefrontal control over hippocampal retrieval. Two paradigms:

- **Retrieval-induced forgetting (RIF):** repeatedly retrieving one
  memory from a set inhibits later access to related but un-retrieved
  memories. A direct trade-off: strengthening some traces *weakens*
  competitors.
- **Suppression-induced forgetting (SIF):** voluntary attempts to
  suppress retrieval of a specific item (think-no-think paradigm)
  produce measurable later impairment. Prefrontal cortex exerts
  inhibitory control over the hippocampus; the suppression
  *intervention*, not the natural decay, drives the loss.

The functional story: **forgetting is not just absence of retention.
There are dedicated neural systems for deciding what to lose, when, and
how aggressively.** They serve emotion regulation, abstraction, and
contextual updating. A system without them is not a better memory
system; it is a broken one. This is the *single most important point*
of the whole memory literature for anyone designing a memory abstraction.

*Analog for agent memory: a system that never forgets, never
prioritises, never inhibits competitors is not a feature-complete
memory system — it is a log file with retrieval.*

---

## 11. What's missing or contested

Honest acknowledgement of unsettled questions:

**The molecular basis of long-term storage.** LTP is the dominant model
and the correlations with learning are extensive, but the **causal**
identity "LTP = the storage mechanism" is not nailed down. Abraham et
al.'s
[*Is plasticity of synapses the mechanism of long-term memory storage?* (2019)](https://www.nature.com/articles/s41539-019-0048-y)
catalogues the open questions: LTP decays faster than memories last,
many memories survive substantial synaptic remodelling, and
synthesis-blocking drugs in different preparations give variable
results. Engram-cell experiments (Tonegawa lab) show that specific
neuronal ensembles can be reactivated to retrieve memories, but the
mechanism by which they encode *content* (synaptic weights? structural
connectivity? something else?) is open.

**Reconsolidation in humans.** As reviewed in §6, robust in rodent fear
conditioning, much shakier in human paradigms outside fear, and with
prediction-error gating that is not yet well characterised. The
*possibility* that retrieval rewrites the trace is real; the
*reliability* of inducing this effect outside the lab is uncertain.

**Standard model vs Multiple Trace Theory.** Whether truly old
episodic memories ever become hippocampus-independent, or whether they
just become more semantic-and-hippocampus-still-needed, is contested.
Lesion data and imaging data point different directions; the field has
not converged on a synthesis even three decades after the debate
opened.

**Function of dreaming.** Three plausible families (memory replay,
threat simulation, predictive-coding model maintenance), none
decisive, possibly all partially correct, possibly the question is
malformed.

**Capacity of working memory.** Cowan's ~4 is the dominant estimate,
but the field has not agreed on whether capacity is a fixed slot
count, a continuous resource that gets divided, or a flexible mixture
([Modelling Working Memory Capacity](https://journalofcognition.org/articles/10.5334/joc.387)).

**How decay and interference combine.** Both are real, both contribute,
the relative weighting is content- and context-dependent and not
captured by a single equation.

The honest position across all of these: **the broad architecture is
well-mapped (multi-store, multi-system, hippocampal-cortical division,
consolidation, active forgetting), the mechanisms are partially
mapped, and the molecular and computational fine details are still
genuinely open.** A redesign should treat the broad architecture as
strong scaffolding and treat specific mechanistic analogies as
suggestive rather than authoritative.

---

## Key sources

A short list of the most-load-bearing references, in roughly the order
they appear:

1. Squire, L. R. (2004). Memory systems of the brain: A brief history
   and current perspective. *Neurobiology of Learning and Memory* 82,
   171–177.
   [PDF](http://whoville.ucsd.edu/PDFs/384_Squire_%20NeurobiolLearnMem2004.pdf)
2. Craik, F. I. M. & Lockhart, R. S. (1972). Levels of processing: A
   framework for memory research. *JVLVB* 11, 671–684.
   [PDF](http://wixtedlab.ucsd.edu/publications/Psych%20218/Craik_Lockhart_1972.pdf)
3. Cowan, N. (2001). The magical number 4 in short-term memory: A
   reconsideration of mental storage capacity. *Behavioral and Brain
   Sciences* 24, 87–185.
   [BBS](https://www.cambridge.org/core/journals/behavioral-and-brain-sciences/article/magical-number-4-in-shortterm-memory-a-reconsideration-of-mental-storage-capacity/44023F1147D4A1D44BDC0AD226838496)
4. Baddeley, A. (2000). The episodic buffer: a new component of working
   memory? *Trends in Cognitive Sciences* 4, 417–423; and Hitch, Allen
   & Baddeley (2025).
   [Fifty-years review](https://journals.sagepub.com/doi/10.1177/17470218241290909)
5. McClelland, J. L., McNaughton, B. L. & O'Reilly, R. C. (1995). Why
   there are complementary learning systems in the hippocampus and
   neocortex. *Psychological Review* 102, 419–457.
   [PDF](https://stanford.edu/~jlmcc/papers/McCMcNaughtonOReilly95.pdf)
6. Murre, J. M. J. & Dros, J. (2015). Replication and analysis of
   Ebbinghaus's forgetting curve. *PLOS ONE* 10, e0120644.
   [PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC4492928/)
7. Nader, K. & Hardt, O. (2009). A single standard for memory: the case
   for reconsolidation. *Nature Reviews Neuroscience* 10, 224–234.
   [Nature](https://www.nature.com/articles/nrn2590)
8. Roediger, H. L. & Karpicke, J. D. (2006). The power of testing
   memory: basic research and implications for educational practice.
   *Perspectives on Psychological Science* 1, 181–210.
   [PDF](http://psychnet.wustl.edu/memory/wp-content/uploads/2018/04/Roediger-Karpicke-2006_PPS.pdf)
9. Wilson, M. A. & McNaughton, B. L. (1994). Reactivation of
   hippocampal ensemble memories during sleep. *Science* 265,
   676–679.
   [PDF](https://www.weizmann.ac.il/brain-sciences/labs/ulanovsky/sites/neurobiology.labs.ulanovsky/files/uploads/wilson_mcnaughton_reactivationofhippocampalensembleactivity_science_1994.pdf)
10. Klinzing, J. G., Niethard, N. & Born, J. (2019). Mechanisms of
    systems memory consolidation during sleep. *Nature Neuroscience*
    22, 1598–1610.
    [Nature](https://www.nature.com/articles/s41593-019-0467-3)
11. McGaugh, J. L. (2004). The amygdala modulates the consolidation of
    memories of emotionally arousing experiences. *Annual Review of
    Neuroscience* 27, 1–28.
    [Annual Reviews](https://www.annualreviews.org/content/journals/10.1146/annurev.neuro.27.070203.144157)
12. Sinclair, A. H. et al. (2021). Prediction errors disrupt
    hippocampal representations and update episodic memories. *PNAS*
    118, e2117625118.
    [PNAS](https://www.pnas.org/doi/10.1073/pnas.2117625118)
13. Nørby, S. (2015). Why forget? On the adaptive value of memory loss.
    *Perspectives on Psychological Science* 10, 551–578.
    [SAGE](https://journals.sagepub.com/doi/10.1177/1745691615596787)
14. Anderson, M. C. & Hulbert, J. C. (2021). Active forgetting:
    adaptation of memory by prefrontal control. *Annual Review of
    Psychology* 72, 1–36.
    [PDF](https://memorycontrol.net/2021Anderson.pdf)
15. Chase, W. G. & Simon, H. A. (1973). Perception in chess.
    *Cognitive Psychology* 4, 55–81.
    [PDF](https://andymatuschak.org/prompts/Chase1973.pdf);
    and Gobet, F. (1998). Expert memory: a comparison of four theories.
    *Cognition* 66, 115–152.
    [PubMed](https://pubmed.ncbi.nlm.nih.gov/9677761/)
16. Hobson, J. A. & Friston, K. J. (2014). Virtual reality and
    consciousness inference in dreaming. *Frontiers in Psychology* 5,
    1133.
    [Frontiers](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2014.01133/full)
17. Valli, K. & Revonsuo, A. (2009). The threat simulation theory in
    light of recent empirical evidence: a review.
    *American Journal of Psychology* 122, 17–38.
    [PubMed](https://pubmed.ncbi.nlm.nih.gov/15766897/)
18. Abraham, W. C., Jones, O. D. & Glanzman, D. L. (2019). Is
    plasticity of synapses the mechanism of long-term memory storage?
    *npj Science of Learning* 4, 9.
    [Nature](https://www.nature.com/articles/s41539-019-0048-y)
19. Moscovitch, M. et al. (2005). Functional neuroanatomy of remote
    episodic, semantic and spatial memory: a unified account based on
    multiple trace theory. *Journal of Anatomy* 207, 35–66; debate
    summary in [Two Views](https://link.springer.com/article/10.1007/s11559-007-9003-9).
20. Bartlett, F. C. (1932). *Remembering: A Study in Experimental and
    Social Psychology.* Cambridge University Press. Overview:
    [Wikipedia](https://en.wikipedia.org/wiki/Reconstructive_memory).
21. Sperling, G. (1960). The information available in brief visual
    presentations. *Psychological Monographs* 74, 1–29.
    [PDF](https://sites.socsci.uci.edu/~whipl/staff/sperling/PDFs/Sperling_PsychMonogr_1960.pdf)
22. Renoult, L. & Rugg, M. D. (2020). An historical perspective on
    Endel Tulving's episodic–semantic distinction. *Neuropsychologia*
    139, 107366.
    [PubMed](https://pubmed.ncbi.nlm.nih.gov/32007511/)
23. Mesulam, M. M. et al. — primary progressive aphasia as a dementia
    of the language network.
    [PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC3975615/)
24. Michaelian, K. & Sutton, J. *Memory.* Stanford Encyclopedia of
    Philosophy.
    [SEP](https://plato.stanford.edu/entries/memory/)

---

*End of document. Next step: a parallel survey of how production
LLM-agent and software memory systems currently work, then a
gap-analysis, then design proposals. Nothing in this file should be
read as a design recommendation; it is a vocabulary and a set of
constraints for the design work to come.*
