'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { usePathname } from 'next/navigation';
import { useRouter } from '@/core/i18n/routing';
import { Random } from 'random-js';
import { useClick, useCorrect, useError } from '@/shared/hooks/useAudio';
import { shuffle } from '@/shared/lib/shuffle';
import { saveSession } from '@/shared/lib/gauntletStats';
import useGauntletSettingsStore from '@/shared/store/useGauntletSettingsStore';

import { statsTracking } from '@/features/Progress';
import EmptyState from './EmptyState';
import PreGameScreen from './PreGameScreen';
import ActiveGame from './ActiveGame';
import ResultsScreen from './ResultsScreen';
import {
  DIFFICULTY_CONFIG,
  type GauntletConfig,
  type GauntletDifficulty,
  type GauntletGameMode,
  type GauntletQuestion,
  type GauntletSessionStats,
  type RepetitionCount,
} from './types';

// Re-export types for external use
export type { GauntletGameMode, GauntletConfig } from './types';

const random = new Random();

interface GauntletProps<T> {
  config: GauntletConfig<T>;
  onCancel?: () => void; // Optional callback for modal mode
}

/**
 * Calculate the threshold for life regeneration based on total questions
 * Scales with game size but has min/max bounds
 */
const calculateRegenThreshold = (totalQuestions: number): number => {
  // 10% of total questions, clamped between 5 and 20
  return Math.max(5, Math.min(20, Math.ceil(totalQuestions * 0.1)));
};

/**
 * Generate a shuffled queue of all questions
 * Each character appears `repetitions` times in random order
 */
function generateQuestionQueue<T>(
  items: T[],
  repetitions: number,
): GauntletQuestion<T>[] {
  const queue: GauntletQuestion<T>[] = [];

  // Create all question entries
  items.forEach(item => {
    for (let rep = 1; rep <= repetitions; rep++) {
      queue.push({
        item,
        index: 0, // Will be set after shuffle
        repetitionNumber: rep,
      });
    }
  });

  // Fisher-Yates shuffle
  for (let i = queue.length - 1; i > 0; i--) {
    const j = random.integer(0, i);
    [queue[i], queue[j]] = [queue[j], queue[i]];
  }

  // Set indices after shuffle
  queue.forEach((q, i) => {
    q.index = i;
  });

  return queue;
}

export default function Gauntlet<T>({ config, onCancel }: GauntletProps<T>) {
  const router = useRouter();
  const pathname = usePathname();
  const isGauntletRoute = pathname?.includes('/gauntlet') ?? false;

  const { playClick } = useClick();
  const { playCorrect } = useCorrect();
  const { playError } = useError();

  // Get persisted settings from store
  const gauntletSettings = useGauntletSettingsStore();

  const {
    dojoType,
    dojoLabel,
    items,
    selectedSets,
    generateQuestion: _generateQuestion,
    renderQuestion,
    checkAnswer: _checkAnswer,
    getCorrectAnswer: _getCorrectAnswer,
    generateOptions,
    renderOption,
    getCorrectOption,
    initialGameMode: _initialGameMode,
  } = config;

  // Game configuration state - initialized from store for all settings
  // The store persists settings across navigation from PreGameScreen to game route
  // Note: Type mode is not yet implemented in Gauntlet's ActiveGame, so we force Pick mode.
  const [gameMode, setGameModeState] = useState<GauntletGameMode>('Pick');
  const [difficulty, setDifficultyState] = useState<GauntletDifficulty>(
    gauntletSettings.getDifficulty(dojoType),
  );
  const [repetitions, setRepetitionsState] = useState<RepetitionCount>(
    gauntletSettings.getRepetitions(dojoType),
  );

  // Wrapper setters that also sync to store for persistence across navigation
  const setGameMode = useCallback(
    (mode: GauntletGameMode) => {
      setGameModeState(mode);
      gauntletSettings.setGameMode(dojoType, mode);
    },
    [dojoType, gauntletSettings],
  );

  const setDifficulty = useCallback(
    (diff: GauntletDifficulty) => {
      setDifficultyState(diff);
      gauntletSettings.setDifficulty(dojoType, diff);
    },
    [dojoType, gauntletSettings],
  );

  const setRepetitions = useCallback(
    (reps: RepetitionCount) => {
      setRepetitionsState(reps);
      gauntletSettings.setRepetitions(dojoType, reps);
    },
    [dojoType, gauntletSettings],
  );

  // Game phase state
  const [phase, setPhase] = useState<'pregame' | 'playing' | 'results'>(
    'pregame',
  );

  // Game state
  const [questionQueue, setQuestionQueue] = useState<GauntletQuestion<T>[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [lives, setLives] = useState(3);
  const [maxLives, setMaxLives] = useState(3);
  const [correctSinceLastRegen, setCorrectSinceLastRegen] = useState(0);
  const [regenThreshold, setRegenThreshold] = useState(10);

  // Stats tracking
  const [correctAnswers, setCorrectAnswers] = useState(0);
  const [wrongAnswers, setWrongAnswers] = useState(0);
  const [currentStreak, setCurrentStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [livesRegenerated, setLivesRegenerated] = useState(0);
  const [characterStats, setCharacterStats] = useState<
    Record<string, { correct: number; wrong: number }>
  >({});

  // Time tracking
  const [startTime, setStartTime] = useState(0);
  const [answerTimes, setAnswerTimes] = useState<number[]>([]);
  const lastAnswerTime = useRef(0);

  // Answer feedback
  const [_lastAnswerCorrect, setLastAnswerCorrect] = useState<boolean | null>(
    null,
  );
  const [_lifeJustGained, setLifeJustGained] = useState(false);
  const [_lifeJustLost, setLifeJustLost] = useState(false);

  // Input state
  const [_userAnswer, setUserAnswer] = useState('');
  const [shuffledOptions, setShuffledOptions] = useState<string[]>([]);
  const [_wrongSelectedAnswers, setWrongSelectedAnswers] = useState<string[]>(
    [],
  );

  // Session stats for results
  const [sessionStats, setSessionStats] = useState<Omit<
    GauntletSessionStats,
    'id'
  > | null>(null);
  const [isNewBest, setIsNewBest] = useState(false);

  const pickModeSupported = !!(generateOptions && getCorrectOption);
  // Gauntlet mode always uses normal mode (never reverse)
  const isReverseActive = false;

  const totalQuestions = items.length * repetitions;
  const currentQuestion = questionQueue[currentIndex] || null;

  // Auto-start state (effect comes after handleStart is defined)
  const [hasAutoStarted, setHasAutoStarted] = useState(false);

  // Track challenge mode usage on mount
  useEffect(() => {
    // Track challenge mode usage for achievements (Requirements 8.1-8.3)
    statsTracking.recordChallengeModeUsed('gauntlet');
    statsTracking.recordDojoUsed(dojoType);
  }, [dojoType]);

  // Generate options when question changes (always uses Pick/tile mode now)
  useEffect(() => {
    if (currentQuestion && generateOptions && phase === 'playing') {
      const options = generateOptions(
        currentQuestion.item,
        items,
        4,
        isReverseActive,
      );
      setShuffledOptions(shuffle(options));
      setWrongSelectedAnswers([]);
    }
  }, [currentQuestion, generateOptions, items, isReverseActive, phase]);

  // Handle game start
  const handleStart = useCallback(() => {
    playClick();

    const queue = generateQuestionQueue(items, repetitions);
    const diffConfig = DIFFICULTY_CONFIG[difficulty];
    const threshold = calculateRegenThreshold(queue.length);

    setQuestionQueue(queue);
    setCurrentIndex(0);
    setLives(diffConfig.lives);
    setMaxLives(diffConfig.lives);
    setCorrectSinceLastRegen(0);
    setRegenThreshold(threshold);

    setCorrectAnswers(0);
    setWrongAnswers(0);
    setCurrentStreak(0);
    setBestStreak(0);
    setLivesRegenerated(0);
    setCharacterStats({});

    const now = Date.now();
    setStartTime(now);
    setAnswerTimes([]);
    lastAnswerTime.current = now;

    setLastAnswerCorrect(null);
    setLifeJustGained(false);
    setLifeJustLost(false);
    setUserAnswer('');
    setWrongSelectedAnswers([]);

    // Generate initial options for the first question
    if (queue.length > 0 && generateOptions) {
      const firstQuestion = queue[0];
      const options = generateOptions(
        firstQuestion.item,
        items,
        4,
        isReverseActive,
      );
      setShuffledOptions(shuffle(options));
    }

    setPhase('playing');
  }, [
    items,
    repetitions,
    difficulty,
    generateOptions,
    isReverseActive,
    playClick,
  ]);

  // Get a unique identifier for the current question item
  const getItemId = useCallback((item: T): string => {
    // Try common patterns for getting an identifier
    if (typeof item === 'object' && item !== null) {
      const obj = item as Record<string, unknown>;
      if ('kana' in obj) return String(obj.kana);
      if ('kanji' in obj) return String(obj.kanji);
      if ('word' in obj) return String(obj.word);
      if ('id' in obj) return String(obj.id);
    }
    return String(item);
  }, []);

  // End game and calculate stats
  // Accepts actual values as parameters to avoid stale closure issues,
  // since React state setters are batched and don't update synchronously.
  const endGame = useCallback(
    async ({
      completed,
      actualLives,
      actualCorrectAnswers,
      actualWrongAnswers,
      actualQuestionsCompleted,
    }: {
      completed: boolean;
      actualLives: number;
      actualCorrectAnswers: number;
      actualWrongAnswers: number;
      actualQuestionsCompleted: number;
    }) => {
      const totalTimeMs = Date.now() - startTime;
      const validAnswerTimes = answerTimes.filter(t => t > 0);

      const stats: Omit<GauntletSessionStats, 'id'> = {
        timestamp: Date.now(),
        dojoType,
        difficulty,
        gameMode,
        totalQuestions,
        correctAnswers: actualCorrectAnswers,
        wrongAnswers: actualWrongAnswers,
        accuracy:
          actualCorrectAnswers + actualWrongAnswers > 0
            ? actualCorrectAnswers /
              (actualCorrectAnswers + actualWrongAnswers)
            : 0,
        bestStreak,
        currentStreak,
        startingLives: maxLives,
        livesRemaining: actualLives,
        livesLost: maxLives - actualLives + livesRegenerated,
        livesRegenerated,
        totalTimeMs,
        averageTimePerQuestionMs:
          validAnswerTimes.length > 0
            ? validAnswerTimes.reduce((a, b) => a + b, 0) /
              validAnswerTimes.length
            : 0,
        fastestAnswerMs:
          validAnswerTimes.length > 0 ? Math.min(...validAnswerTimes) : 0,
        slowestAnswerMs:
          validAnswerTimes.length > 0 ? Math.max(...validAnswerTimes) : 0,
        completed,
        questionsCompleted: actualQuestionsCompleted,
        characterStats,
        totalCharacters: items.length,
        repetitionsPerChar: repetitions,
        selectedSets: selectedSets || [],
      };

      setSessionStats(stats);

      // Save to storage
      const { isNewBest: newBest } = await saveSession(stats);
      setIsNewBest(newBest);

      // Track gauntlet stats for achievements
      const livesLost = maxLives - actualLives + livesRegenerated;
      const isPerfect = stats.accuracy === 1 && completed;
      statsTracking.recordGauntletRun({
        completed,
        difficulty,
        isPerfect,
        livesLost,
        livesRegenerated,
        bestStreak,
      });

      setPhase('results');
    },
    [
      startTime,
      answerTimes,
      dojoType,
      difficulty,
      gameMode,
      totalQuestions,
      bestStreak,
      currentStreak,
      maxLives,
      livesRegenerated,
      characterStats,
      items.length,
      repetitions,
      selectedSets,
    ],
  );

  const recordAnswerTime = useCallback(() => {
    const now = Date.now();
    // Skip recording if lastAnswerTime hasn't been set yet (shouldn't happen,
    // but guard against negative/zero times from race conditions)
    if (lastAnswerTime.current > 0) {
      const timeTaken = now - lastAnswerTime.current;
      if (timeTaken > 0) {
        setAnswerTimes(prev => [...prev, timeTaken]);
      }
    }
    lastAnswerTime.current = now;
  }, []);

  const advanceToNextQuestion = useCallback(
    (
      newLives: number,
      wasCorrect: boolean,
      newCorrectAnswers: number,
      newWrongAnswers: number,
      questionsCompleted: number,
    ) => {
      setUserAnswer('');
      setWrongSelectedAnswers([]);
      setLastAnswerCorrect(null);

      if (newLives <= 0) {
        endGame({
          completed: false,
          actualLives: newLives,
          actualCorrectAnswers: newCorrectAnswers,
          actualWrongAnswers: newWrongAnswers,
          actualQuestionsCompleted: questionsCompleted,
        });
        return;
      }

      if (wasCorrect) {
        // Check if all questions have been answered correctly
        if (newCorrectAnswers >= totalQuestions) {
          endGame({
            completed: true,
            actualLives: newLives,
            actualCorrectAnswers: newCorrectAnswers,
            actualWrongAnswers: newWrongAnswers,
            actualQuestionsCompleted: questionsCompleted,
          });
          return;
        }
        // Move to the next question in the queue
        setCurrentIndex(prev => prev + 1);
      } else {
        // Wrong answer: re-queue this question at a random later position
        // so the user must answer it correctly to complete the gauntlet.
        // Cap re-queuing to prevent unbounded queue growth — if the queue
        // has already grown beyond 3x the original target, stop re-queuing
        // (the player is struggling but still has lives due to regen).
        const maxQueueSize = totalQuestions * 3;
        setQuestionQueue(prev => {
          if (prev.length >= maxQueueSize) {
            // Queue is very large — skip re-queuing to prevent runaway growth
            return prev;
          }
          const newQueue = [...prev];
          const failedQuestion = { ...newQueue[currentIndex] };
          // Insert at a random position between currentIndex+1 and end of queue
          const remainingLength = newQueue.length - (currentIndex + 1);
          const insertOffset =
            remainingLength > 0
              ? random.integer(1, Math.max(1, Math.min(remainingLength, 5)))
              : 1;
          const insertPos = currentIndex + insertOffset;
          newQueue.splice(insertPos, 0, failedQuestion);
          return newQueue;
        });
        // Still advance past the current slot (the re-queued copy is ahead)
        setCurrentIndex(prev => prev + 1);
      }
    },
    [currentIndex, endGame, totalQuestions],
  );

  const submitAnswer = useCallback(
    (isCorrect: boolean) => {
      if (!currentQuestion) return;

      recordAnswerTime();

      if (isCorrect) {
        playCorrect();
        setLastAnswerCorrect(true);

        setCorrectAnswers(prev => prev + 1);
        setCurrentStreak(prev => {
          const newStreak = prev + 1;
          if (newStreak > bestStreak) {
            setBestStreak(newStreak);
          }
          return newStreak;
        });

        const charId = getItemId(currentQuestion.item);
        setCharacterStats(prev => ({
          ...prev,
          [charId]: {
            correct: (prev[charId]?.correct || 0) + 1,
            wrong: prev[charId]?.wrong || 0,
          },
        }));

        const newCorrectAnswers = correctAnswers + 1;
        const questionsCompleted = currentIndex + 1;

        const canRegen = DIFFICULTY_CONFIG[difficulty].regenerates;
        if (canRegen && lives < maxLives) {
          const newCorrectSinceRegen = correctSinceLastRegen + 1;
          if (newCorrectSinceRegen >= regenThreshold) {
            setLives(prev => Math.min(prev + 1, maxLives));
            setCorrectSinceLastRegen(0);
            setLivesRegenerated(prev => prev + 1);
            setLifeJustGained(true);
            setTimeout(() => setLifeJustGained(false), 500);
          } else {
            setCorrectSinceLastRegen(newCorrectSinceRegen);
          }
        }

        advanceToNextQuestion(lives, true, newCorrectAnswers, wrongAnswers, questionsCompleted);
        return;
      }

      playError();
      setLastAnswerCorrect(false);
      setWrongAnswers(prev => prev + 1);
      setCurrentStreak(0);
      setCorrectSinceLastRegen(0);

      const charId = getItemId(currentQuestion.item);
      setCharacterStats(prev => ({
        ...prev,
        [charId]: {
          correct: prev[charId]?.correct || 0,
          wrong: (prev[charId]?.wrong || 0) + 1,
        },
      }));

      const newLives = lives - 1;
      const newWrongAnswers = wrongAnswers + 1;
      const questionsCompletedOnWrong = currentIndex + 1;
      setLives(newLives);
      setLifeJustLost(true);
      setTimeout(() => setLifeJustLost(false), 500);

      advanceToNextQuestion(newLives, false, correctAnswers, newWrongAnswers, questionsCompletedOnWrong);
    },
    [
      advanceToNextQuestion,
      bestStreak,
      correctAnswers,
      correctSinceLastRegen,
      currentIndex,
      currentQuestion,
      difficulty,
      getItemId,
      lives,
      maxLives,
      playCorrect,
      playError,
      recordAnswerTime,
      regenThreshold,
      wrongAnswers,
    ],
  );

  // Handle cancel
  const handleCancel = useCallback(() => {
    playClick();
    if (isGauntletRoute) {
      router.push(`/${dojoType}`);
    } else {
      setPhase('pregame');
    }
  }, [playClick, isGauntletRoute, router, dojoType]);

  // Handler for new ActiveGame component - receives selected option and result directly
  const handleActiveGameSubmit = useCallback(
    (selectedOption: string, isCorrect: boolean) => {
      submitAnswer(isCorrect);
    },
    [submitAnswer],
  );

  // Create unique key for current question
  const questionKey = currentQuestion
    ? `${getItemId(currentQuestion.item)}-${currentQuestion.index}`
    : '';

  // Auto-start when accessed via route (like Blitz)
  useEffect(() => {
    if (!isGauntletRoute) return;
    if (hasAutoStarted) return;
    if (phase !== 'pregame') return;
    if (items.length === 0) return;

    setHasAutoStarted(true);
    handleStart();
  }, [isGauntletRoute, hasAutoStarted, phase, items.length, handleStart]);

  // Render states
  if (items.length === 0) {
    return <EmptyState dojoType={dojoType} dojoLabel={dojoLabel} />;
  }

  if (phase === 'pregame') {
    return (
      <PreGameScreen
        dojoType={dojoType}
        dojoLabel={dojoLabel}
        itemsCount={items.length}
        selectedSets={selectedSets || []}
        gameMode={gameMode}
        setGameMode={setGameMode}
        difficulty={difficulty}
        setDifficulty={setDifficulty}
        repetitions={repetitions}
        setRepetitions={setRepetitions}
        pickModeSupported={pickModeSupported}
        onStart={handleStart}
        onCancel={onCancel}
      />
    );
  }

  if (phase === 'results' && sessionStats) {
    return (
      <ResultsScreen
        dojoType={dojoType}
        stats={sessionStats}
        isNewBest={isNewBest}
        onRestart={handleStart}
        onChangeSettings={() => setPhase('pregame')}
      />
    );
  }

  // Safety check: ActiveGame requires getCorrectOption for Pick mode
  if (!getCorrectOption) {
    return <EmptyState dojoType={dojoType} dojoLabel={dojoLabel} />;
  }

  return (
    <ActiveGame
      dojoType={dojoType}
      currentIndex={correctAnswers}
      totalQuestions={totalQuestions}
      lives={lives}
      maxLives={maxLives}
      currentQuestion={currentQuestion?.item || null}
      renderQuestion={renderQuestion}
      isReverseActive={isReverseActive ?? false}
      shuffledOptions={shuffledOptions}
      renderOption={renderOption}
      items={items}
      onSubmit={handleActiveGameSubmit}
      getCorrectOption={getCorrectOption}
      onCancel={handleCancel}
      questionKey={questionKey}
    />
  );
}
