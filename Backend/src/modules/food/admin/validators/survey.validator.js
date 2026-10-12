import { z } from 'zod';
import { ValidationError } from '../../../../core/auth/errors.js';

const questionSchema = z.object({
    text: z.string().min(1, 'Question text is required'),
    type: z.enum(['text', 'single-choice', 'multiple-choice', 'rating']).optional(),
    options: z.array(z.string()).optional(),
    image: z.string().optional(),
});

const createSurveySchema = z.object({
    title: z.string().min(1, 'title is required'),
    description: z.string().optional(),
    questions: z.array(questionSchema).min(1, 'At least one question is required'),
    status: z.enum(['active', 'inactive']).optional(),
    // Optional ISO date-time; coerced to a Date. Must be in the future.
    closesAt: z.coerce.date().refine((d) => d.getTime() > Date.now(), {
        message: 'Closing date must be in the future',
    }).optional(),
});

const statusSchema = z.object({
    status: z.enum(['active', 'inactive']),
});

const answerSchema = z.object({
    questionId: z.string().min(1),
    answer: z.union([z.string(), z.number(), z.array(z.string())]),
});

const submitResponseSchema = z.object({
    answers: z.array(answerSchema).min(1, 'At least one answer is required'),
});

const parse = (schema, body) => {
    const result = schema.safeParse(body || {});
    if (!result.success) {
        throw new ValidationError(result.error.errors[0].message);
    }
    return result.data;
};

export const validateCreateSurveyDto = (body) => parse(createSurveySchema, body);
export const validateSurveyStatusDto = (body) => parse(statusSchema, body);
export const validateSubmitSurveyResponseDto = (body) => parse(submitResponseSchema, body);
