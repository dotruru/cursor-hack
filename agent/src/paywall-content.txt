"use client"
import React, { useState } from "react"
import { nutribotAnalytics } from "@/lib/posthog"
import type { OnboardingData } from "@/lib/onboarding-types"

type Props = { data: OnboardingData }

export function Paywall({ data }: Props) {
  const [loading, setLoading] = useState(false)
  const calories = data.dailyCalorieTarget
  const goal = data.goal?.replace("_", " ") ?? "your goal"

  const handleStart = () => {
    setLoading(true)
    nutribotAnalytics.startedFreeTrial()
    setTimeout(() => {
      nutribotAnalytics.completedOnboarding()
      window.location.href = "/dashboard"
    }, 800)
  }

  const handleSkip = () => {
    nutribotAnalytics.skippedPaywall()
    nutribotAnalytics.completedOnboarding()
    window.location.href = "/dashboard"
  }

  return (
    <div className="min-h-screen flex flex-col bg-white">
      <div className="w-full h-1.5 bg-gray-100">
        <div className="h-full bg-black transition-all duration-700" style={{ width: "100%" }} />
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-6 py-10 text-center">
        <div className="mb-3 text-4xl">🎯</div>
        <h1 className="text-3xl font-bold text-gray-900 tracking-tight leading-tight mb-3">
          Your plan is ready.
        </h1>
        <p className="text-gray-500 text-base mb-8 max-w-xs">
          Based on your profile, NutriBot will help you{" "}
          <span className="font-semibold text-gray-800">{goal}</span>
          {calories ? ` — targeting ${calories} kcal/day` : ""}.
        </p>

        <ul className="w-full max-w-xs text-left space-y-3 mb-10">
          {[
            "AI-personalised daily calorie targets",
            "Weekly progress tracking and insights",
            "Flexible meal logging — no strict rules",
            "Adjust goals anytime as life changes",
          ].map((item) => (
            <li key={item} className="flex items-start gap-2 text-sm text-gray-700">
              <span className="text-green-500 font-bold mt-0.5">✓</span>
              {item}
            </li>
          ))}
        </ul>

        <p className="text-xs text-gray-400 mb-6">
          Join 12,000+ people already hitting their targets with NutriBot
        </p>

        <button
          onClick={handleStart}
          disabled={loading}
          className="w-full max-w-xs bg-black text-white font-semibold py-4 rounded-2xl text-base mb-3 disabled:opacity-60 transition-opacity"
        >
          {loading ? "Setting up your dashboard..." : "Start Free Trial - 7 days free"}
        </button>

        <button onClick={handleSkip} className="text-xs text-gray-400 underline">
          Skip for now
        </button>

        <p className="mt-4 text-xs text-gray-300">Then $9.99/month. Cancel anytime.</p>
      </div>
    </div>
  )
}
