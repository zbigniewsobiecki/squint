module Api
  class BaseController < ApplicationController
    before_action :authenticate!

    private

    def render_success(data, status: :ok)
      render json: { data: data }, status: status
    end

    def render_error(message, status: :unprocessable_entity)
      render json: { error: message }, status: status
    end

    def render_not_found(resource = 'Resource')
      render json: { error: "#{resource} not found" }, status: :not_found
    end

    def paginate(scope)
      page = (params[:page] || 1).to_i
      per_page = [(params[:per_page] || 25).to_i, 100].min
      scope.offset((page - 1) * per_page).limit(per_page)
    end
  end
end
