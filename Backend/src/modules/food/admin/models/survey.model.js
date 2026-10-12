import mongoose from 'mongoose';

const surveyQuestionSchema = new mongoose.Schema(
    {
        text: { type: String, required: true, trim: true },
        type: { type: String, enum: ['text', 'single-choice', 'multiple-choice', 'rating'], default: 'text' },
        options: { type: [String], default: [] },
        // Optional image shown with the question in the survey popup.
        image: { type: String, default: '', trim: true },
    },
    { _id: true }
);

const surveySchema = new mongoose.Schema(
    {
        // Human-readable id ("SUR-0001") assigned on creation; the Mongo _id
        // stays the primary key, this is what the admin list and exports show.
        surveyId: { type: String, unique: true, sparse: true, index: true },
        title: { type: String, required: true, trim: true },
        description: { type: String, default: '', trim: true },
        // Admin defines however many questions the survey needs.
        questions: {
            type: [surveyQuestionSchema],
            required: true,
            validate: {
                validator: (v) => Array.isArray(v) && v.length > 0,
                message: 'A survey needs at least one question',
            },
        },
        // Optional closing date — after this instant the survey stops being
        // shown to new users even while its status is still "active". Null
        // means it stays open until an admin deactivates it.
        closesAt: { type: Date, default: null },
        // Only one survey is ever "active" (shown to new users) at a time —
        // enforced in survey.service.js by deactivating others on activation.
        status: { type: String, enum: ['active', 'inactive'], default: 'inactive', index: true },
    },
    { collection: 'food_surveys', timestamps: true }
);

export const FoodSurvey = mongoose.model('FoodSurvey', surveySchema);
