import mongoose from 'mongoose';
import { FoodSurvey } from '../models/survey.model.js';
import { FoodSurveyResponse } from '../models/surveyResponse.model.js';
import { nextSurveyId } from '../models/counter.model.js';
import { FoodUser } from '../../../../core/users/user.model.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';

const toObjectId = (value, label = 'Id') => {
    if (!value || !mongoose.Types.ObjectId.isValid(String(value))) {
        throw new ValidationError(`Invalid ${label}`);
    }
    return new mongoose.Types.ObjectId(String(value));
};

export async function createSurvey(dto) {
    const survey = await FoodSurvey.create({
        surveyId: await nextSurveyId(),
        title: dto.title,
        description: dto.description || '',
        questions: dto.questions,
        closesAt: dto.closesAt || null,
        status: dto.status || 'inactive',
    });

    if (survey.status === 'active') {
        await FoodSurvey.updateMany({ _id: { $ne: survey._id }, status: 'active' }, { $set: { status: 'inactive' } });
    }

    return { survey: survey.toObject() };
}

export async function listSurveys() {
    const surveys = await FoodSurvey.find().sort({ createdAt: -1 }).lean();
    return { surveys };
}

/**
 * Everything the admin needs to download a survey's results: the survey with
 * its questions, every answered response (with who answered and when), and
 * headline counts. Only answered responses are returned — rows that were only
 * shown but never submitted are counted in stats, not listed.
 */
export async function getSurveyResponses(surveyId) {
    const id = toObjectId(surveyId, 'surveyId');
    const survey = await FoodSurvey.findById(id).lean();
    if (!survey) throw new NotFoundError('Survey not found');

    const [shown, responses] = await Promise.all([
        FoodSurveyResponse.countDocuments({ surveyId: id }),
        FoodSurveyResponse.find({ surveyId: id, answeredAt: { $ne: null } })
            .populate('userId', 'name phone email')
            .sort({ answeredAt: -1 })
            .lean(),
    ]);

    return {
        survey: {
            _id: survey._id,
            surveyId: survey.surveyId || '',
            title: survey.title,
            questions: (survey.questions || []).map((q) => ({
                _id: q._id,
                text: q.text,
                type: q.type,
            })),
        },
        responses: responses.map((r) => ({
            user: r.userId
                ? { name: r.userId.name || '', phone: r.userId.phone || '', email: r.userId.email || '' }
                : { name: '', phone: '', email: '' },
            answeredAt: r.answeredAt,
            answers: r.answers || [],
        })),
        stats: { shown, answered: responses.length },
    };
}

export async function setSurveyStatus(surveyId, status) {
    const id = toObjectId(surveyId, 'surveyId');
    const survey = await FoodSurvey.findById(id);
    if (!survey) throw new NotFoundError('Survey not found');

    survey.status = status;
    await survey.save();

    // Only one survey is ever active — activating this one retires any other.
    if (status === 'active') {
        await FoodSurvey.updateMany({ _id: { $ne: id }, status: 'active' }, { $set: { status: 'inactive' } });
    }

    return { survey: survey.toObject() };
}

/**
 * Returns the current survey to show this user, or null if there's nothing
 * to show — no active survey, this user predates the survey (not "new"
 * relative to when it went live), or they've already been shown it.
 * Recording shownAt here (not on submit) is what makes it show only once,
 * even if the user backs out without answering.
 */
export async function getActiveSurveyForUser(userId) {
    const survey = await FoodSurvey.findOne({ status: 'active' }).lean();
    if (!survey) return { survey: null };

    // Past its closing date — stop showing it even though it's still active.
    if (survey.closesAt && new Date(survey.closesAt) < new Date()) {
        return { survey: null };
    }

    const user = await FoodUser.findById(userId).select('createdAt').lean();
    if (!user) throw new NotFoundError('User not found');

    // Only genuinely new users (account created after the survey went live)
    // are eligible — existing users at launch time are never shown it.
    if (new Date(user.createdAt) < new Date(survey.createdAt)) {
        return { survey: null };
    }

    const existing = await FoodSurveyResponse.findOne({ surveyId: survey._id, userId }).lean();
    if (existing) return { survey: null };

    await FoodSurveyResponse.create({ surveyId: survey._id, userId, shownAt: new Date() });
    return { survey };
}

export async function submitSurveyResponse(userId, surveyId, answers) {
    const id = toObjectId(surveyId, 'surveyId');
    const response = await FoodSurveyResponse.findOne({ surveyId: id, userId });
    if (!response) {
        throw new ValidationError('This survey was never shown to you');
    }
    if (response.answeredAt) {
        throw new ValidationError('You have already answered this survey');
    }

    const survey = await FoodSurvey.findById(id).select('questions').lean();
    const validQuestionIds = new Set((survey?.questions || []).map((q) => String(q._id)));
    for (const a of answers) {
        if (!validQuestionIds.has(String(a.questionId))) {
            throw new ValidationError(`Unknown question: ${a.questionId}`);
        }
    }

    response.answers = answers.map((a) => ({ questionId: a.questionId, answer: a.answer }));
    response.answeredAt = new Date();
    await response.save();

    return { response: response.toObject() };
}
